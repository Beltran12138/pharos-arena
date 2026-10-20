#!/usr/bin/env node
// On-Chain Alert Bot (Pharos Agent Arena, Easy): watch Pharos for the conditions in rules.json (large token
// transfers, Chainlink price crossings) and send each alert once to Telegram.
//
//   node --env-file=.env alert-bot/bot.mjs [--rules rules.json] [--state state.json] [--interval 5]
//                                          [--from-block N] [--for seconds] [--console]
//
// Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment; --console (or a missing token)
// prints alerts with timestamps instead. Transfers come from Chain MCP get_logs, prices from Chainlink feeds
// read through Chain MCP eth_call. State (next block, delivered alert ids, price-rule arming, undelivered
// alerts) is saved after every poll, so a restart neither misses nor repeats an alert.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import { connect } from "../lib/mcp.mjs";
import { readFeed } from "../lib/pharos.mjs";
import { Seen, format, priceAlert, tokenOf, transferAlerts } from "./rules.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const rulesPath = opt("--rules", new URL("./rules.json", import.meta.url));
const statePath = opt("--state", new URL("./state.json", import.meta.url));
const intervalMs = Number(opt("--interval", "5")) * 1000;
const stopAt = opt("--for", null) ? Date.now() + Number(opt("--for")) * 1000 : Infinity;
const MAX_RANGE = 1000; // Chain MCP get_logs limit

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TOPIC0 = toEventSelector(TRANSFER);
const { rules } = JSON.parse(readFileSync(rulesPath, "utf8"));
const transferRules = rules.filter((r) => r.type === "transfer");
const priceRules = rules.filter((r) => r.type === "price");

const tg = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
const useTelegram = !args.includes("--console") && tg.token && tg.chat;

const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const seen = new Seen(saved.seen);
const armed = saved.price ?? {};
let pending = saved.pending ?? [];

const mcp = await connect();
const head = async () => Number((await mcp.call("get_block_number")).blockNumber);
let next = saved.nextBlock ?? Number(opt("--from-block", String(await head())));

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
console.log(`${stamp()} alert bot: ${rules.length} rule(s), from block ${next}, delivering to ${useTelegram ? `Telegram chat ${tg.chat}` : "console"}`);
for (const r of rules) console.log(`  - ${r.id}: ${describe(r)}`);

let sent = 0;
try {
  for (;;) {
    const found = [...(await checkTransfers()), ...(await checkPrices())];
    for (const a of found) if (!seen.has(a.id) && !pending.some((p) => p.id === a.id)) pending.push(a);
    pending = await deliver(pending);
    save();
    if (Date.now() >= stopAt) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
} finally {
  await mcp.close();
}
console.log(`${stamp()} stopped at block ${next - 1}: ${sent} alert(s) sent${pending.length ? `, ${pending.length} undelivered (kept for next run)` : ""}`);

async function checkTransfers() {
  if (!transferRules.length) return [];
  const tip = await head();
  const addresses = [...new Set(transferRules.map((r) => tokenOf(r.token).address))];
  const out = [];
  while (next <= tip) {
    const to = Math.min(tip, next + MAX_RANGE - 1);
    const res = await mcp.call("get_logs", { address: addresses, topics: [TOPIC0], fromBlock: String(next), toBlock: String(to) });
    const logs = Array.isArray(res) ? res : res.logs ?? [];
    for (const rule of transferRules) {
      const mine = logs.filter((l) => l.address.toLowerCase() === tokenOf(rule.token).address && l.topics.length === 3);
      const decoded = mine.map((l) => decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }).args);
      out.push(...transferAlerts(rule, mine, decoded));
    }
    next = to + 1;
  }
  return out;
}

async function checkPrices() {
  const out = [];
  for (const rule of priceRules) {
    const feed = await readFeed(mcp, rule.pair);
    const r = priceAlert(rule, feed, armed[rule.id]);
    armed[rule.id] = r.state;
    if (r.alert) out.push(r.alert);
  }
  return out;
}

/** Send each alert; ones that fail stay pending and are retried next poll. Returns what is still pending. */
async function deliver(alerts) {
  const left = [];
  for (const a of alerts) {
    if (seen.has(a.id)) continue;
    try {
      if (useTelegram) await telegram(format(a, true));
      console.log(`${stamp()} ALERT ${format(a)}`);
      seen.add(a.id);
      sent++;
    } catch (e) {
      console.log(`${stamp()} delivery failed for ${a.id}: ${e.message} (will retry)`);
      left.push(a);
    }
  }
  return left;
}

async function telegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${body.error_code}: ${body.description}`);
}

function save() {
  writeFileSync(statePath, JSON.stringify({ nextBlock: next, price: armed, pending, seen }, null, 1));
}

function describe(r) {
  if (r.type === "transfer") return `any ${r.token} transfer ≥ ${r.min} ${r.token}`;
  return `${r.pair} ${r.above != null ? `≥ ${r.above}` : `≤ ${r.below}`} (re-arms after ${r.rearmPct ?? 0.5}% back)`;
}
