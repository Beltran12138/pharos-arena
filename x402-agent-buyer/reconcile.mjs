#!/usr/bin/env node
// Check the agent's ledgers against the chain, not against themselves: every USDC transfer the buyer made on
// Atlantic since --from-block, matched to the ledger entries (by transaction). A settled ledger entry with no
// matching on-chain transfer, an amount that differs, or a transaction counted twice is an error. Transfers that are
// in no ledger are listed (e.g. the paywalled API's own demo, which pays outside the agent).
//
//   node --env-file=.env.atlantic x402-agent-buyer/reconcile.mjs --from-block 31664002
import { readdirSync, readFileSync } from "node:fs";
import { formatUnits, getAddress, parseAbiItem } from "viem";
import { USDC, atlantic, need } from "../x402-paywalled-api/config.mjs";
import { fold } from "./budget.mjs";

const args = process.argv.slice(2);
const from = BigInt(args[args.indexOf("--from-block") + 1]);
const buyer = getAddress(need("BUYER_ADDRESS"));
const chain = atlantic();
const u = (x) => `$${formatUnits(BigInt(x), USDC.decimals)}`;

const dir = new URL("./ledger/", import.meta.url);
const entries = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const lines = readFileSync(new URL(f, dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const p of Object.values(fold(lines))) entries.push({ job: f.replace(".jsonl", ""), ...p });
}
const settled = entries.filter((e) => e.status === "settled");

const head = await chain.getBlockNumber();
const transfers = [];
for (let a = from; a <= head; a += 1000n) {
  const b = a + 999n > head ? head : a + 999n;
  for (let i = 0; ; i++) {
    try {
      transfers.push(...(await chain.getLogs({ address: USDC.address, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), args: { from: buyer }, fromBlock: a, toBlock: b })));
      break;
    } catch (e) {
      if (i >= 3) throw e;
    }
  }
}
const onChain = new Map(transfers.map((t) => [t.transactionHash, t]));

let errors = 0;
console.log(`buyer ${buyer}: ${transfers.length} USDC transfers on chain in blocks ${from}–${head}; ${settled.length} settled payments in ${new Set(entries.map((e) => e.job)).size} ledgers\n`);
const seen = new Set();
for (const e of settled) {
  const t = onChain.get(e.tx);
  const dup = seen.has(e.tx);
  seen.add(e.tx);
  const ok = t && !dup && t.args.value === BigInt(e.amount);
  if (!ok) errors++;
  console.log(`  ${ok ? "✓" : "✗"} ${e.job} ${e.resource.padEnd(56)} ${u(e.amount).padEnd(7)} ${e.tx.slice(0, 12)}… ${t ? `on chain ${u(t.args.value)} → ${t.args.to.slice(0, 8)}…` : "NOT ON CHAIN"}${dup ? " COUNTED TWICE" : ""}${e.note ? ` (${e.note})` : ""}`);
}
const outside = transfers.filter((t) => !seen.has(t.transactionHash));
if (outside.length) console.log(`\n  in no agent ledger (paid by something else, e.g. x402-paywalled-api/demo.mjs):`);
for (const t of outside) console.log(`    ${t.transactionHash.slice(0, 12)}… block ${t.blockNumber} ${u(t.args.value)} → ${t.args.to.slice(0, 8)}…`);
const notSettled = entries.filter((e) => e.status !== "settled");
if (notSettled.length) console.log(`\n  not settled (counted as nothing): ${notSettled.map((e) => `${e.job} ${e.resource} ${e.status}`).join("; ")}`);
const total = settled.reduce((s, e) => s + BigInt(e.amount), 0n);
console.log(`\n→ ${errors ? `${errors} MISMATCH(ES)` : "every ledger payment is on chain, once, for its amount"}; agent total ${u(total)}, all buyer transfers ${u(transfers.reduce((s, t) => s + t.args.value, 0n))}`);
if (errors) process.exitCode = 1;
