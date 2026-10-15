#!/usr/bin/env node
// Policy Gatekeeper (Pharos Agent Arena, Medium): every action an agent wants to take on Pharos goes through
// here first. Denied actions are logged and never signed; allowed actions are simulated through Chain MCP
// (estimate_gas) and, in `exec` mode, signed locally and broadcast through Chain MCP send_raw_transaction.
//
//   node policy-gatekeeper/gatekeeper.mjs check  <requests.json> [--policy p.json] [--log audit.jsonl]
//   node policy-gatekeeper/gatekeeper.mjs exec   <requests.json> [--policy p.json] [--log audit.jsonl]
//   node policy-gatekeeper/gatekeeper.mjs verify [--log audit.jsonl]
//
// check: dry-run. A request may carry "at" (ISO time) to test the time-window rule; it is recorded as a
//        simulated clock. exec: live. Uses the real clock and ignores "at"; needs PRIVATE_KEY in the env.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { signAndSend } from "../lib/send.mjs";
import { compile, evaluate } from "./policy.mjs";
import { append, spentOn, verify } from "./auditlog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const cmd = args[0];
const policyPath = opt("--policy", join(here, "policy.json"));
const logPath = opt("--log", join(here, "audit.jsonl"));

/** Accept a friendly request ({value: "0.001", call: {fn, args}}) and produce {to, valueWei, data}. */
export function normalize(req) {
  const valueWei = req.valueWei ?? (req.value ? parseEther(req.value).toString() : "0");
  let data = req.data ?? "0x";
  if (req.call) {
    const abi = parseAbi([`function ${req.call.fn}`]);
    data = encodeFunctionData({ abi, functionName: abi[0].name, args: req.call.args ?? [] });
  }
  return { to: req.to, valueWei, data };
}

async function run(mode) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const compiled = compile(policy);
  const file = args[1];
  if (!file) throw new Error("usage: gatekeeper.mjs check|exec <requests.json>");
  const reqs = [JSON.parse(readFileSync(file, "utf8"))].flat();

  let account = null;
  if (mode === "live") {
    if (!process.env.PRIVATE_KEY) throw new Error("exec needs PRIVATE_KEY in the environment");
    account = privateKeyToAccount(process.env.PRIVATE_KEY);
    if (policy.signer && policy.signer.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`PRIVATE_KEY is for ${account.address}, but the policy is for signer ${policy.signer}`);
    }
  }
  // Dry-run before a signer is configured: simulate from a public funded address.
  const from = account?.address ?? policy.signer ?? policy.simulateFrom;

  const mcp = await connect();
  try {
    for (const req of reqs) {
      const action = normalize(req);
      const simulatedClock = mode === "dry-run" && req.at ? req.at : null;
      const at = simulatedClock ? new Date(simulatedClock) : new Date();
      const verdict = evaluate(compiled, action, at, spentOn(logPath, at, mode));

      let execution = null;
      if (verdict.decision === "allow") execution = await simulateAndMaybeSend(mcp, mode, account, from, action);

      const entry = append(logPath, {
        at: at.toISOString(),
        mode,
        ...(simulatedClock ? { simulatedClock: true } : {}),
        policyVersion: policy.version,
        request: { id: req.id, note: req.note, ...action },
        decision: verdict.decision,
        rule: verdict.rule,
        reason: verdict.reason,
        spends: verdict.spends,
        checks: verdict.checks,
        ...(execution ? { execution } : {}),
      });
      print(entry);
    }
  } finally {
    await mcp.close();
  }
}

async function simulateAndMaybeSend(mcp, mode, account, from, action) {
  const tx = { from, to: action.to, value: "0x" + BigInt(action.valueWei).toString(16), data: action.data };
  let gas;
  try {
    const est = await mcp.call("estimate_gas", { transaction: tx });
    gas = BigInt(est.gas ?? est.gasEstimate ?? est.result ?? est);
  } catch (e) {
    return { status: "simulation-failed", error: String(e.message).slice(0, 300) };
  }
  if (mode === "dry-run") return { status: "simulated", gas: gas.toString() };

  const { gasPriceWei } = await mcp.call("get_gas_price");
  const { balanceWei } = await mcp.call("get_balance", { address: account.address });
  const cost = BigInt(action.valueWei) + gas * BigInt(gasPriceWei) * 2n;
  if (BigInt(balanceWei) < cost) return { status: "not-sent", error: `balance ${balanceWei} wei < value + gas ${cost} wei` };

  const sent = await signAndSend(mcp, account, { to: action.to, value: BigInt(action.valueWei), data: action.data, gas: (gas * 12n) / 10n });
  return { ...sent, gasUsed: sent.gasUsed?.toString(), predictedGas: gas.toString() };
}

function print(e) {
  const mark = e.decision === "allow" ? "ALLOW" : "DENY ";
  const clock = e.simulatedClock ? " (simulated clock)" : "";
  console.log(`#${e.seq} ${mark} ${e.request.id ?? ""}  ${e.request.note ?? ""}`);
  console.log(`    rule: ${e.rule ?? "-"}  ${e.reason}  @ ${e.at}${clock}`);
  if (e.execution) {
    const x = e.execution;
    console.log(`    execution: ${x.status}${x.gas ? ` (gas ${x.gas})` : ""}${x.link ? ` ${x.link}` : ""}${x.error ? ` ${x.error}` : ""}`);
  }
}

if (cmd === "check") await run("dry-run");
else if (cmd === "exec") await run("live");
else if (cmd === "verify") {
  const r = verify(logPath);
  console.log(r.ok ? `audit log OK: ${r.lines} decisions, hash chain intact` : `audit log BROKEN at line ${r.at}: ${r.why}`);
  process.exitCode = r.ok ? 0 : 1;
} else {
  console.log("usage: gatekeeper.mjs check|exec <requests.json> | verify   [--policy p.json] [--log audit.jsonl]");
  process.exitCode = 2;
}
