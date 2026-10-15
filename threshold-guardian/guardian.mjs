#!/usr/bin/env node
// Threshold Guardian (Pharos Agent Arena, Medium): a Skill that checks several on-chain conditions together
// and fires its action only when all of them pass. Every run writes a decision trace.
//
//   node threshold-guardian/guardian.mjs <config.json> [--log trace.jsonl]
//
// Condition types (all read through Chain MCP):
//   gasPrice      { maxGwei }                               get_gas_price
//   tokenBalance  { token, holder, min }                    eth_call balanceOf
//   feedAge       { pair, maxSeconds }                      Chainlink latestRoundData vs block time
//   feedPrice     { pair, op, value }                       Chainlink latestRoundData
//   feedMovePct   { pair, reference, minPct }               |price − reference| / reference
//   poolVsOracle  { pool, pair, maxDeviationPct }           V3 slot0 price vs Chainlink
import { appendFileSync, readFileSync } from "node:fs";
import { erc20Abi } from "viem";
import { connect } from "../lib/mcp.mjs";
import { TOKENS, human, label, read, readFeed } from "../lib/pharos.mjs";
import { readPool } from "../lib/pool.mjs";

const OPS = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };

const CHECKS = {
  async gasPrice(mcp, c) {
    const gwei = Number((await mcp.call("get_gas_price")).gasPriceGwei);
    return { value: `${gwei} gwei`, pass: gwei <= c.maxGwei, rule: `≤ ${c.maxGwei} gwei` };
  },
  async tokenBalance(mcp, c, ctx) {
    const t = TOKENS[c.token.toLowerCase()];
    const bal = await read(mcp, c.token, erc20Abi, "balanceOf", [c.holder], ctx.block);
    const v = Number(bal) / 10 ** t.decimals;
    return { value: `${human(bal, t.decimals, 2)} ${t.symbol} in ${label(c.holder)}`, pass: v >= c.min, rule: `≥ ${c.min.toLocaleString("en-US")} ${t.symbol}` };
  },
  async feedAge(mcp, c, ctx) {
    const f = await readFeed(mcp, c.pair, ctx.block);
    const age = ctx.time - f.updatedAt;
    return { value: `${c.pair} updated ${age} s ago`, pass: age <= c.maxSeconds, rule: `≤ ${c.maxSeconds} s` };
  },
  async feedPrice(mcp, c, ctx) {
    const f = await readFeed(mcp, c.pair, ctx.block);
    return { value: `${c.pair} = ${f.price.toFixed(6)}`, pass: OPS[c.op](f.price, c.value), rule: `${c.op} ${c.value}` };
  },
  async feedMovePct(mcp, c, ctx) {
    const f = await readFeed(mcp, c.pair, ctx.block);
    const move = ((f.price - c.reference) / c.reference) * 100;
    return { value: `${c.pair} ${f.price.toFixed(6)} vs reference ${c.reference} (${move >= 0 ? "+" : ""}${move.toFixed(2)}%)`, pass: Math.abs(move) >= c.minPct, rule: `|move| ≥ ${c.minPct}%` };
  },
  async poolVsOracle(mcp, c, ctx) {
    const [p, f] = await Promise.all([readPool(mcp, c.pool, ctx.block), readFeed(mcp, c.pair, ctx.block)]);
    const dev = ((p.price - f.price) / f.price) * 100;
    return { value: `pool ${p.price.toFixed(6)} vs oracle ${f.price.toFixed(6)} (${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%)`, pass: Math.abs(dev) <= c.maxDeviationPct, rule: `|deviation| ≤ ${c.maxDeviationPct}%` };
  },
};

const args = process.argv.slice(2);
const cfgPath = args.find((a) => !a.startsWith("--"));
const logPath = args.includes("--log") ? args[args.indexOf("--log") + 1] : "threshold-guardian/trace.jsonl";
if (!cfgPath) {
  console.error("usage: guardian.mjs <config.json> [--log trace.jsonl]");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
for (const c of cfg.conditions) if (!CHECKS[c.type]) throw new Error(`unknown condition type ${c.type}`);
if (cfg.conditions.length < 1) throw new Error("no conditions");

const mcp = await connect();
try {
  const { blockNumber } = await mcp.call("get_block_number");
  const blk = await mcp.call("get_block", { block: blockNumber });
  const ctx = { block: blockNumber, time: Number(BigInt(blk.timestamp)) };
  const results = [];
  for (const c of cfg.conditions) {
    let r;
    try {
      r = await CHECKS[c.type](mcp, c, ctx);
    } catch (e) {
      r = { value: `could not read: ${e.message.slice(0, 120)}`, pass: false, rule: "readable" }; // unreadable = fail closed
    }
    results.push({ name: c.name ?? c.type, type: c.type, ...r });
  }
  const fire = results.every((r) => r.pass);
  const trace = {
    at: new Date(ctx.time * 1000).toISOString(),
    block: Number(blockNumber),
    guardian: cfg.name,
    decision: fire ? "FIRE" : "HOLD",
    action: cfg.action,
    conditions: results,
  };
  appendFileSync(logPath, JSON.stringify(trace) + "\n");

  console.log(`${cfg.name} — block ${Number(blockNumber).toLocaleString("en-US")} (${trace.at}), via Chain MCP`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(34)} ${r.value}   [${r.rule}]`);
  if (fire) {
    console.log(`\nDecision: FIRE → ${cfg.action.description}`);
    if (cfg.action.request) console.log(`  prepared request (hand to dry-run-executor / policy-gatekeeper):\n  ${JSON.stringify(cfg.action.request)}`);
  } else {
    const failed = results.filter((r) => !r.pass).map((r) => r.name);
    console.log(`\nDecision: HOLD (${failed.length} of ${results.length} conditions failed: ${failed.join(", ")}). Nothing prepared.`);
  }
  console.log(`trace appended to ${logPath}`);
  process.exitCode = fire ? 0 : 10;
} finally {
  await mcp.close();
}

