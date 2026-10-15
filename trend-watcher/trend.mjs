#!/usr/bin/env node
// Trend Watcher (Pharos Agent Arena, Hard): a Skill with memory. Each run takes ONE observation through Chain
// MCP and appends it to a persistent store; the trend rule is evaluated over the stored history, and the
// action fires only once a trend is confirmed over several observations.
//
//   node trend-watcher/trend.mjs observe [--config trend.json] [--at-block N]   one run (schedule it)
//   node trend-watcher/trend.mjs history [--config trend.json]                  stored history + triggers
//   --store file.jsonl overrides the store; --inject V records V instead of measuring (tests, marked as injected)
//
// Store: an append-only JSONL file. Observations are keyed by block number, so re-running for a block that is
// already stored adds nothing (restarts and retries can't duplicate history). Triggers are stored too, so a
// trend that already fired is not fired again after a restart.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../lib/mcp.mjs";
import { readFeed } from "../lib/pharos.mjs";
import { readPool } from "../lib/pool.mjs";
import { evaluate } from "./rule.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cmd = args[0];
const cfg = JSON.parse(readFileSync(opt("--config", new URL("./trend.json", import.meta.url)), "utf8"));
const store = opt("--store", null) ?? fileURLToPath(new URL(cfg.store, new URL("./", import.meta.url)));

function load() {
  if (!existsSync(store)) return { obs: [], triggers: [] };
  const lines = readFileSync(store, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { obs: lines.filter((l) => l.type === "obs").sort((a, b) => a.block - b.block), triggers: lines.filter((l) => l.type === "trigger") };
}
function append(rec) {
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, JSON.stringify(rec) + "\n");
}

/** The metric, read through Chain MCP at one block. */
async function measure(mcp, block) {
  if (cfg.metric.type === "poolPrice") return (await readPool(mcp, cfg.metric.pool, block)).price;
  if (cfg.metric.type === "feedPrice") return (await readFeed(mcp, cfg.metric.pair, block)).price;
  throw new Error(`unknown metric ${cfg.metric.type}`);
}

if (cmd === "observe") {
  const mcp = await connect();
  try {
    const block = Number(opt("--at-block", (await mcp.call("get_block_number")).blockNumber));
    const state = load();
    if (state.obs.some((o) => o.block === block)) {
      console.log(`block ${block} already observed; nothing added (store has ${state.obs.length} observations)`);
    } else {
      const time = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
      // --inject: record a given value instead of measuring (tests only; marked in the store and the output).
      const injected = opt("--inject", null);
      const value = injected !== null ? Number(injected) : await measure(mcp, String(block));
      const seq = Math.max(0, ...state.obs.map((o) => o.seq)) + 1;
      const rec = { type: "obs", seq, block, time: new Date(time * 1000).toISOString(), value, ...(injected !== null ? { injected: true } : {}) };
      append(rec);
      state.obs.push(rec);
      state.obs.sort((a, b) => a.block - b.block);
      console.log(`#${rec.seq} block ${block} ${rec.time}  ${cfg.metric.label} = ${value.toFixed(6)}${rec.injected ? "  [INJECTED test value]" : ""}`);
    }
    const r = evaluate(state.obs, cfg.rule);
    const already = r.met && state.triggers.some((t) => t.fromBlock === r.window[0].block);
    if (r.met && !already) {
      const t = { type: "trigger", at: new Date().toISOString(), fromBlock: r.window[0].block, toBlock: r.window[1].block, fromSeq: r.window[0].seq, toSeq: r.window[1].seq, totalPct: r.totalPct, action: cfg.action };
      append(t);
      console.log(`\n>>> TREND CONFIRMED at observation #${r.window[1].seq} (block ${r.window[1].block}, ${r.window[1].time}): ${r.reason}`);
      console.log(`>>> action: ${cfg.action}`);
    } else if (r.met) console.log(`trend already fired for the window starting at block ${r.window[0].block}; not firing again`);
    else console.log(`no trigger: ${r.reason}`);
  } finally {
    await mcp.close();
  }
} else if (cmd === "history") {
  const { obs, triggers } = load();
  console.log(`${cfg.name}: ${obs.length} observations, ${triggers.length} trigger(s); rule ${JSON.stringify(cfg.rule)}\n`);
  let prev = null;
  for (const o of obs) {
    const step = prev ? ((o.value - prev.value) / prev.value) * 100 : null;
    const t = triggers.find((x) => x.toSeq === o.seq);
    console.log(`  #${String(o.seq).padStart(3)} block ${o.block} ${o.time.slice(0, 16)}  ${o.value.toFixed(6)}  ${step === null ? "" : `${step >= 0 ? "+" : ""}${step.toFixed(3)}%`}${o.injected ? "  [injected]" : ""}${t ? `   <<< TRIGGER (window #${t.fromSeq}–#${t.toSeq}, ${t.totalPct.toFixed(3)}%)` : ""}`);
    prev = o;
  }
} else {
  console.log("usage: trend.mjs observe [--at-block N] | history   [--config trend.json]");
  process.exitCode = 2;
}
