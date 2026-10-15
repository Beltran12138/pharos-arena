import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, parseEther } from "viem";
import { compile, evaluate } from "../policy-gatekeeper/policy.mjs";
import { append, spentOn, verify } from "../policy-gatekeeper/auditlog.mjs";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const OTHER = "0x1111111111111111111111111111111111111111";
const policy = JSON.parse(readFileSync(new URL("../policy-gatekeeper/policy.json", import.meta.url), "utf8"));
const c = compile(policy);
const DAY = new Date("2026-10-15T03:00:00Z"); // 11:00 HKT, inside the window
const NIGHT = new Date("2026-10-15T18:30:00Z"); // 02:30 HKT
const erc20 = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const pros = (v) => parseEther(v).toString();

test("allowlisted native transfer inside the window and limits is allowed", () => {
  const r = evaluate(c, { to: DEAD, valueWei: pros("0.0001") }, DAY);
  assert.equal(r.decision, "allow");
  assert.equal(r.rule, null);
});

test("each rule type denies and names itself", () => {
  const cases = [
    [{ to: OTHER, valueWei: pros("0.0001") }, DAY, {}, "allowlist.recipient"],
    [{ to: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29", data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [OTHER, 1n] }) }, DAY, {}, "allowlist.contract"],
    [{ to: WPROS, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [OTHER, 1n] }) }, DAY, {}, "allowlist.function"],
    [{ to: DEAD, valueWei: pros("0.0001") }, NIGHT, {}, "timeWindow"],
    [{ to: DEAD, valueWei: pros("0.0011") }, DAY, {}, "spendLimit.perTx"],
    [{ to: DEAD, valueWei: pros("0.001") }, DAY, { PROS: parseEther("0.0011") }, "spendLimit.perDay"],
  ];
  for (const [action, at, spent, rule] of cases) {
    const r = evaluate(c, action, at, spent);
    assert.equal(r.decision, "deny", rule);
    assert.equal(r.rule, rule);
  }
});

test("limits are inclusive: exactly the per-tx and per-day amount is allowed", () => {
  assert.equal(evaluate(c, { to: DEAD, valueWei: pros("0.001") }, DAY, { PROS: parseEther("0.001") }).decision, "allow");
});

test("ERC-20 transfer counts as spend of that token and checks its recipient", () => {
  const ok = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DEAD, 500000n] }) };
  assert.equal(evaluate(c, ok, DAY).decision, "allow");
  const big = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DEAD, 500001n] }) };
  assert.equal(evaluate(c, big, DAY).rule, "spendLimit.perTx");
  const elsewhere = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [OTHER, 1n] }) };
  assert.equal(evaluate(c, elsewhere, DAY).rule, "allowlist.recipient");
});

test("a token with no configured limit cannot be spent", () => {
  const p = structuredClone(policy);
  p.allowlist.contracts[USDC] = ["transfer(address,uint256)"];
  delete p.spendLimit.perTx.USDC;
  const r = evaluate(compile(p), { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DEAD, 1n] }) }, DAY);
  assert.equal(r.decision, "deny");
});

test("window end is exclusive", () => {
  assert.equal(evaluate(c, { to: DEAD, valueWei: "1" }, new Date("2026-10-15T15:59:00Z")).decision, "allow");
  assert.equal(evaluate(c, { to: DEAD, valueWei: "1" }, new Date("2026-10-15T16:00:00Z")).rule, "timeWindow");
});

test("audit log: hash chain detects an edited decision; spend counts only allowed, same day, same mode", () => {
  const path = join(mkdtempSync(join(tmpdir(), "gk-")), "log.jsonl");
  const base = { mode: "dry-run", request: {}, rule: null, reason: "", checks: [] };
  append(path, { ...base, at: DAY.toISOString(), decision: "allow", spends: [{ symbol: "PROS", amount: "5" }] });
  append(path, { ...base, at: DAY.toISOString(), decision: "deny", spends: [{ symbol: "PROS", amount: "100" }] });
  append(path, { ...base, at: DAY.toISOString(), mode: "live", decision: "allow", spends: [{ symbol: "PROS", amount: "7" }], execution: { status: "success" } });
  append(path, { ...base, at: "2026-10-14T03:00:00Z", decision: "allow", spends: [{ symbol: "PROS", amount: "9" }] });
  assert.deepEqual(spentOn(path, DAY, "dry-run"), { PROS: 5n });
  assert.deepEqual(spentOn(path, DAY, "live"), { PROS: 7n });
  assert.equal(verify(path).ok, true);

  const lines = readFileSync(path, "utf8").split("\n");
  lines[1] = lines[1].replace('"deny"', '"allow"');
  writeFileSync(path, lines.join("\n"));
  const v = verify(path);
  assert.equal(v.ok, false);
  assert.equal(v.at, 2);
});
