#!/usr/bin/env node
// Gas Fee Optimizer (Pharos Agent Arena, Medium): track the gas price on Pharos mainnet, hold a non-urgent
// transaction until gas is favourable or its deadline arrives, and report what it actually paid.
//
//   node gas-fee-optimizer/gas.mjs history [--hours 24]                    sample past blocks → history.jsonl
//   node gas-fee-optimizer/gas.mjs monitor [--interval 30] [--for s]       live samples → history.jsonl
//   node --env-file=.env gas-fee-optimizer/gas.mjs submit <request.json>   hold, then sign + send at the right time
//
// All chain data through Chain MCP (get_block with transactions, get_gas_price, estimate_gas, receipts);
// the transaction is signed locally with PRIVATE_KEY and broadcast with Chain MCP send_raw_transaction.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { signAndSend } from "../lib/send.mjs";
import { decide, gwei, report, targetFrom } from "./policy.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cmd = args[0];
const historyPath = join(here, "history.jsonl");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const readHistory = () => (existsSync(historyPath) ? readFileSync(historyPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const mcp = await connect();
const head = async () => Number((await mcp.call("get_block_number")).blockNumber);

/** One block: base fee, fullness, and what its transactions actually paid. */
async function sampleBlock(n) {
  const b = await mcp.call("get_block", { block: String(n), includeTransactions: true });
  const prices = (b.transactions ?? []).map((t) => BigInt(t.gasPrice ?? t.maxFeePerGas ?? 0)).sort((x, y) => (x < y ? -1 : 1));
  const base = BigInt(b.baseFeePerGas ?? 0);
  return {
    block: n,
    time: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(),
    baseFee: base.toString(),
    fullnessPct: Number((BigInt(b.gasUsed) * 1_000_000n) / BigInt(b.gasLimit)) / 1e4,
    txs: prices.length,
    paidMedian: prices.length ? prices[prices.length >> 1].toString() : null,
    paidMax: prices.length ? prices.at(-1).toString() : null,
    paidAboveBase: prices.filter((p) => p > base).length,
    paidSum: prices.reduce((s, p) => s + p, 0n).toString(),
  };
}

function printHistory(rows) {
  console.log(`${"time (UTC)".padEnd(20)} ${"block".padStart(9)}  base fee   full%   txs  median paid  max paid   above base`);
  for (const r of rows) {
    console.log(`${r.time.slice(0, 19).replace("T", " ")} ${String(r.block).padStart(9)}  ${gwei(r.baseFee).padEnd(9)} ${r.fullnessPct.toFixed(3).padStart(6)}  ${String(r.txs).padStart(4)}  ${(r.paidMedian ? gwei(r.paidMedian) : "–").padEnd(12)} ${(r.paidMax ? gwei(r.paidMax) : "–").padEnd(10)} ${r.paidAboveBase}`);
  }
  const bases = rows.map((r) => BigInt(r.baseFee));
  const txs = rows.reduce((s, r) => s + r.txs, 0);
  const above = rows.reduce((s, r) => s + r.paidAboveBase, 0);
  const paid = rows.reduce((s, r) => s + BigInt(r.paidSum), 0n);
  const baseSum = rows.reduce((s, r) => s + BigInt(r.baseFee) * BigInt(r.txs), 0n);
  console.log(`\n${rows.length} samples: base fee min ${gwei(bases.reduce((a, b) => (a < b ? a : b)))}, max ${gwei(bases.reduce((a, b) => (a > b ? a : b)))}; ` +
    `${txs} transactions, ${above} paid above the base fee; on average they paid ${txs ? ((Number(paid) / Number(baseSum) - 1) * 100).toFixed(1) : 0}% more than the base fee.`);
}

try {
  if (cmd === "history") {
    const hours = Number(opt("--hours", "24"));
    const tip = await head();
    const step = Math.round((hours * 3600) / 48); // ~1 s blocks: 48 samples over the window
    const rows = [];
    for (let i = 47; i >= 0; i--) rows.push(await sampleBlock(tip - i * step));
    for (const r of rows) appendFileSync(historyPath, JSON.stringify({ source: "backfill", ...r }) + "\n");
    printHistory(rows);
  } else if (cmd === "monitor") {
    const stopAt = Date.now() + Number(opt("--for", "300")) * 1000;
    while (Date.now() < stopAt) {
      const r = { source: "live", ...(await sampleBlock(await head())), quoted: (await mcp.call("get_gas_price")).gasPriceWei };
      appendFileSync(historyPath, JSON.stringify(r) + "\n");
      console.log(`${stamp()} block ${r.block}: base ${gwei(r.baseFee)}, eth_gasPrice ${gwei(r.quoted)}, ${r.txs} txs, full ${r.fullnessPct}%`);
      await new Promise((res) => setTimeout(res, Number(opt("--interval", "30")) * 1000));
    }
  } else if (cmd === "submit") {
    await submit(JSON.parse(readFileSync(args[1], "utf8")));
  } else {
    console.log("usage: gas.mjs history [--hours h] | monitor [--interval s] [--for s] | submit <request.json>");
    process.exitCode = 2;
  }
} finally {
  await mcp.close();
}

/**
 * request: { id, to, value (PROS), data?, deadline ("+180s" or ISO), marginSec?, targetGwei? }
 * Holds until the gas price is at or below the target (default: the low end of the last 24 h, never below the
 * floor) or until deadline − margin, then signs and sends at the node's current gas price.
 */
async function submit(req) {
  if (!process.env.PRIVATE_KEY) throw new Error("submit needs PRIVATE_KEY in the environment");
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  const requested = Date.now() / 1000;
  const deadline = /^\+\d+s$/.test(req.deadline) ? requested + Number(req.deadline.slice(1, -1)) : Date.parse(req.deadline) / 1000;
  const marginSec = req.marginSec ?? 20;
  const requestBlock = await head();
  const requestPrice = BigInt((await mcp.call("get_gas_price")).gasPriceWei);
  const day = readHistory().filter((h) => Date.parse(h.time) / 1000 > requested - 86400);
  const floor = day.length ? day.map((h) => BigInt(h.baseFee)).reduce((a, b) => (a < b ? a : b)) : requestPrice;
  const target = req.targetGwei != null ? BigInt(Math.round(req.targetGwei * 1e9)) : targetFrom(day, floor);
  const tx = { to: req.to, value: parseEther(String(req.value ?? "0")), data: req.data ?? "0x" };
  const est = await mcp.call("estimate_gas", { transaction: { from: account.address, to: tx.to, value: toHex(tx.value), data: tx.data } });
  const gas = BigInt(est.gas ?? est.gasEstimate ?? est.result ?? est);

  console.log(`${stamp()} request ${req.id}: ${req.value ?? 0} PROS to ${req.to}, gas ≈ ${gas}`);
  console.log(`  price at request ${gwei(requestPrice)} (block ${requestBlock}); target ${gwei(target)}${req.targetGwei != null ? " (set in the request)" : ` (low end of ${day.length} samples in the last 24 h)`}`);
  console.log(`  deadline ${new Date(deadline * 1000).toISOString()}; latest submit ${marginSec}s before it`);

  let d;
  for (;;) {
    const current = BigInt((await mcp.call("get_gas_price")).gasPriceWei);
    d = decide({ now: Date.now() / 1000, deadline, marginSec, current, target });
    console.log(`${stamp()} ${d.action.toUpperCase()}: ${d.why}`);
    if (d.action === "submit") break;
    await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(1000, (deadline - marginSec - Date.now() / 1000) * 1000))));
  }
  const sent = await signAndSend(mcp, account, { ...tx, gas: (gas * 12n) / 10n });
  const receipt = await mcp.call("get_transaction_receipt", { hash: sent.hash });
  const paidPrice = BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice);
  const minedAt = Number(BigInt((await mcp.call("get_block", { block: String(sent.block) })).timestamp));

  // What others paid between the request and our inclusion (up to 20 blocks sampled evenly).
  const span = Math.max(1, sent.block - requestBlock);
  const picks = [...new Set([...Array(20).keys()].map((i) => requestBlock + Math.round((i * span) / 19)))];
  let sum = 0n, n = 0n;
  for (const b of picks) {
    const s = await sampleBlock(b);
    sum += BigInt(s.paidSum);
    n += BigInt(s.txs);
  }
  const others = n ? sum / n : null;
  const r = report({ gasUsed: sent.gasUsed, paidPrice, requestPrice, othersAvgPrice: others });
  const out = {
    id: req.id, requestedAt: new Date(requested * 1000).toISOString(), deadline: new Date(deadline * 1000).toISOString(),
    submittedBecause: d.why, tx: sent.hash, link: sent.link, status: sent.status, block: sent.block, minedAt: new Date(minedAt * 1000).toISOString(),
    metDeadline: minedAt <= deadline, gasUsed: sent.gasUsed.toString(), requestPrice: requestPrice.toString(), paidPrice: paidPrice.toString(),
    othersAvgPrice: others?.toString() ?? null, cost: r.cost.toString(), savedVsRequest: r.savedVsRequest.toString(), savedVsOthers: r.savedVsOthers?.toString() ?? null,
  };
  appendFileSync(join(here, "runs.jsonl"), JSON.stringify(out) + "\n");
  const pros = (w) => `${(Number(w) / 1e18).toFixed(8)} PROS`;
  console.log(`\n${req.id}: ${sent.status} in block ${sent.block} at ${out.minedAt} (${out.metDeadline ? "before" : "AFTER"} the deadline) ${sent.link}`);
  console.log(`  paid ${gwei(paidPrice)} × ${sent.gasUsed} gas = ${pros(r.cost)}`);
  console.log(`  vs price at request (${gwei(requestPrice)}): ${pros(r.atRequest)} → saved ${pros(r.savedVsRequest)}`);
  if (others) console.log(`  vs what others paid meanwhile (avg ${gwei(others)} over ${n} txs): ${pros(r.atOthers)} → saved ${pros(r.savedVsOthers)}`);
}
