#!/usr/bin/env node
// Batch Executor (Pharos Agent Arena, Medium): several independent native PROS transfers in one Multicall3
// aggregate3Value transaction instead of one transaction each.
//
//   node batch-executor/batch.mjs plan <actions.json>                      simulate, choose, estimate (no key)
//   node --env-file=.env batch-executor/batch.mjs exec <actions.json>      plan, then sign + send the batch
//   node batch-executor/batch.mjs verify <actions.json> <txHash>          check a sent batch on chain (no key)
//
// Every action is first simulated on its own (estimate_gas from the sender, through Chain MCP). Actions that
// would fail are left out and reported with the reason; the rest go into one aggregate3Value call with
// allowFailure = false, so the batch is all-or-nothing and no PROS can be left stranded in Multicall3 (with
// allowFailure = true, a failed call's value would stay in the Multicall3 contract, where anyone can take it).
// Only native transfers are batched: ERC-20 transfers from the sender would need an allowance to Multicall3,
// which anyone can call, so this Skill never approves it.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, getAddress, isAddress, parseAbi, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { human, readAgreed } from "../lib/pharos.mjs";
import { signAndSend } from "../lib/send.mjs";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC_ABI = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address) view returns (uint256)",
]);
const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const [cmd, file] = args;
const spec = JSON.parse(readFileSync(file ?? "", "utf8"));
const pros = (w) => `${w < 0n ? "-" : ""}${human(w < 0n ? -w : w, 18, 8)} PROS`; // human() drops the sign of small negatives
const toNum = (x) => BigInt(x.gas ?? x.gasEstimate ?? x.result ?? x);

const mcp = await connect();
try {
  const from = cmd === "exec" ? privateKeyToAccount(process.env.PRIVATE_KEY ?? (() => { throw new Error("exec needs PRIVATE_KEY"); })()).address : getAddress(spec.from);
  const plan = await makePlan(from);
  if (cmd === "exec") await execute(plan);
  else if (cmd === "verify") await verify(plan, args[2]);
  else if (cmd !== "plan") throw new Error("usage: batch.mjs plan|exec|verify <actions.json> [txHash]");
} finally {
  await mcp.close();
}

async function makePlan(from) {
  console.log(`Batch of ${spec.actions.length} actions from ${from} (Pharos mainnet)\n`);
  const ok = [], left = [];
  for (const a of spec.actions) {
    const value = parseEther(String(a.value));
    if (!isAddress(a.to)) {
      left.push({ ...a, why: `"${a.to}" is not an address` });
      continue;
    }
    try {
      const gas = toNum(await mcp.call("estimate_gas", { transaction: { from, to: a.to, value: toHex(value), data: "0x" } }));
      ok.push({ ...a, to: getAddress(a.to), value, gas });
      console.log(`  ok    ${a.id.padEnd(10)} ${pros(value).padStart(18)} → ${a.to}  alone: ${gas} gas`);
    } catch (e) {
      const why = /"message":\s*"([^"]+)"/.exec(e.message)?.[1] ?? e.message.slice(0, 120);
      left.push({ ...a, why });
      console.log(`  FAIL  ${a.id.padEnd(10)} ${pros(value).padStart(18)} → ${a.to}  alone: ${why} — left out of the batch`);
    }
  }
  if (ok.length < 2) throw new Error(`only ${ok.length} action(s) can run; nothing worth batching`);

  const calls = ok.map((a) => ({ target: a.to, allowFailure: false, value: a.value, callData: "0x" }));
  const total = ok.reduce((s, a) => s + a.value, 0n);
  const data = encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3Value", args: [calls] });
  const batchGas = toNum(await mcp.call("estimate_gas", { transaction: { from, to: MULTICALL3, value: toHex(total), data } }));
  const alone = ok.reduce((s, a) => s + a.gas, 0n);
  const saved = alone - batchGas;
  console.log(`\n  ${ok.length} transactions, ${alone} gas → 1 transaction, ${batchGas} gas: saves ${saved} gas (${((Number(saved) / Number(alone)) * 100).toFixed(1)}%) and ${ok.length - 1} signatures/nonces`);
  if (left.length) console.log(`  left out: ${left.map((a) => `${a.id} (${a.why})`).join("; ")}`);
  // Batching has ~36k gas of fixed overhead (scaling.txt): below ~4 transfers it costs more gas than it saves.
  const worth = batchGas < alone || spec.optimize === "steps";
  console.log(worth
    ? `  decision: BATCH (${batchGas < alone ? "cheaper in gas" : `costs ${-saved} more gas, but optimize = "steps" asks for fewer transactions`})`
    : `  decision: SEPARATE: the batch would cost ${-saved} more gas than ${ok.length} plain transfers; set "optimize": "steps" to batch anyway`);

  // What allowFailure = true would have done with the failing action included: simulate, do not send.
  const bad = left.find((a) => isAddress(a.to));
  if (bad) {
    const v = parseEther(String(bad.value));
    const risky = [...calls.map((c) => ({ ...c, allowFailure: true })), { target: getAddress(bad.to), allowFailure: true, value: v, callData: "0x" }];
    const head = Number((await mcp.call("get_block_number")).blockNumber);
    const before = await readAgreed(mcp, MULTICALL3, MC_ABI, "getEthBalance", [MULTICALL3], head);
    const res = await mcp.call("eth_call", { transaction: { from, to: MULTICALL3, value: toHex(total + v), data: encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3Value", args: [risky] }) }, block: String(head) });
    const strict = await mcp.call("eth_call", { transaction: { from, to: MULTICALL3, value: toHex(total + v), data: encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3Value", args: [risky.map((c) => ({ ...c, allowFailure: false }))] }) }, block: String(head) }).then(() => "succeeds", (e) => `reverts (${/"message":\s*"([^"]+)"/.exec(e.message)?.[1] ?? "error"})`);
    // eth_call shows that the call succeeds, not the balances after it. That the failed call's value stays in
    // Multicall3 is from Multicall3's code: aggregate3Value does not refund the value of a call that failed.
    console.log(`\n  Why allowFailure is false (simulated with eth_call, not sent): with ${bad.id} included and allowFailure = true the batch ` +
      `${res ? "succeeds" : "?"} even though ${bad.id} fails, and Multicall3's aggregate3Value does not refund a failed call's value, ` +
      `so ${bad.id}'s ${pros(v)} would be left in Multicall3 (which holds ${pros(before)} now, free for anyone to take). ` +
      `With allowFailure = false the same batch ${strict}, so nothing moves.`);
  }
  return { from, ok, left, calls, total, data, batchGas, alone, worth };
}

async function execute(plan) {
  if (!plan.worth) {
    console.log("\nNot sent: batching these would cost more gas than sending them separately (see decision above).");
    process.exitCode = 1;
    return;
  }
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  console.log(`\nSending the batch: ${pros(plan.total)} to Multicall3 aggregate3Value`);
  const sent = await signAndSend(mcp, account, { to: MULTICALL3, value: plan.total, data: plan.data, gas: (plan.batchGas * 12n) / 10n });
  await verify(plan, sent.hash);
}

/**
 * What the batch did, from the chain: the receipt, and each address's balance change in the batch's block,
 * against what the actions add up to per address (one address can appear in several actions). The sender is
 * expected to change by −(total sent) + (what it sent to itself) − fee.
 */
async function verify(plan, hash) {
  const r = await mcp.call("get_transaction_receipt", { hash });
  const status = r.status === "0x1" ? "success" : "reverted";
  const block = Number(BigInt(r.blockNumber));
  const gasUsed = BigInt(r.gasUsed);
  const fee = gasUsed * BigInt(r.effectiveGasPrice ?? r.gasPrice);
  const from = getAddress(r.from);
  console.log(`\nBatch ${hash}\n  ${status} in block ${block}, gas used ${gasUsed}, fee ${pros(fee)}  https://www.pharosscan.xyz/tx/${hash}`);

  const expected = {};
  for (const a of plan.ok) expected[a.to] = (expected[a.to] ?? 0n) + (status === "success" ? a.value : 0n);
  expected[from] = (expected[from] ?? 0n) - (status === "success" ? plan.total : 0n) - fee;
  const actual = {};
  for (const addr of Object.keys(expected)) {
    const after = await readAgreed(mcp, MULTICALL3, MC_ABI, "getEthBalance", [addr], block);
    const prev = await readAgreed(mcp, MULTICALL3, MC_ABI, "getEthBalance", [addr], block - 1);
    actual[addr] = after - prev;
    console.log(`  ${addr}: balance change ${pros(actual[addr])}, expected ${pros(expected[addr])} ${actual[addr] === expected[addr] ? "✓" : "✗ (another transfer in the same block?)"}`);
  }
  const results = [];
  for (const a of plan.ok) {
    const st = status !== "success" ? "not executed (batch reverted, nothing moved)" : actual[a.to] === expected[a.to] ? "done" : "unclear: balance change differs";
    results.push({ id: a.id, to: a.to, value: a.value.toString(), status: st });
    console.log(`  ${a.id.padEnd(10)} ${pros(a.value).padStart(16)} → ${a.to}  ${st}`);
  }
  for (const a of plan.left) {
    results.push({ id: a.id, to: a.to, value: String(a.value), status: "left out before sending", why: a.why });
    console.log(`  ${a.id.padEnd(10)} ${String(a.value).padStart(11)} PROS → ${a.to}  left out before sending: ${a.why}`);
  }
  const saved = plan.alone - gasUsed;
  console.log(`\n  Actual: 1 transaction, ${gasUsed} gas vs ${plan.alone} gas for ${plan.ok.length} separate transfers: saved ${saved} gas ` +
    `(${((Number(saved) / Number(plan.alone)) * 100).toFixed(1)}%) and ${plan.ok.length - 1} transactions. (The plan's estimate was ${plan.batchGas}; estimate_gas over-states this call.)`);
  appendFileSync(join(here, "runs.jsonl"), JSON.stringify({ at: new Date().toISOString(), tx: hash, status, block, gasUsed: gasUsed.toString(), fee: fee.toString(), estimate: plan.batchGas.toString(), aloneGas: plan.alone.toString(), results }) + "\n");
}
