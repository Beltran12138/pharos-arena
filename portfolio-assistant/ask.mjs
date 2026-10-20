#!/usr/bin/env node
// Portfolio Assistant (Pharos Agent Arena, Hard): plain-language questions about one wallet's positions across
// its own balances, tokenized vaults and Morpho Blue, answered with sources. Read-only: it holds no key and never
// prepares or sends a transaction.
//
//   node portfolio-assistant/ask.mjs --wallet 0x… "what am I earning?" ["where is my USDC?" …]
//   node portfolio-assistant/ask.mjs --wallet 0x…            (then one question per line on stdin)
//
// One snapshot per run (one block): every answer in the run is about the same state.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { connect } from "../lib/mcp.mjs";
import { answer } from "./answer.mjs";
import { snapshot } from "./snapshot.mjs";

const args = process.argv.slice(2);
const wallet = args[args.indexOf("--wallet") + 1];
const questions = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--wallet");
const reg = JSON.parse(readFileSync(new URL("../lib/protocols.json", import.meta.url), "utf8"));

const mcp = await connect();
let s;
try {
  console.log(`Reading ${wallet} across the wallet, ${reg.vaults.length} vaults and ${reg.morphoMarkets.length} Morpho markets (Chain MCP)…`);
  s = await snapshot(mcp, wallet, reg);
} finally {
  await mcp.close();
}
console.log(`Snapshot at block ${s.block} (${s.time}): ${s.rows.length} positions, ${s.unreadable.length} unreadable.\n`);
const ask = (q) => console.log(`Q: ${q}\nA: ${answer(q, s)}\n`);
if (questions.length) questions.forEach(ask);
else for await (const line of createInterface({ input: process.stdin })) if (line.trim()) ask(line.trim());
