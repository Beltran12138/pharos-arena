#!/usr/bin/env node
// Liquidation Watchdog (Pharos Agent Arena, Medium): watch Morpho Blue borrow positions on Pharos mainnet and
// alert before they reach liquidation, with a concrete repair in every alert.
//
//   node liquidation-watchdog/watchdog.mjs discover                                  list live borrow positions
//   node --env-file=.env liquidation-watchdog/watchdog.mjs check  [--config c.json]  one pass
//   node --env-file=.env liquidation-watchdog/watchdog.mjs watch  [--config c.json] [--interval 60] [--for s]
//
// Position, market and oracle price are read through Chain MCP at one pinned block, each taken only when two
// reads agree; interest since the market's last update is accrued with the market's own IRM rate, so the
// debt is what Morpho would charge right now. Alerts go to Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
// and to the console with timestamps; --console skips Telegram.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, erc20Abi, formatUnits, parseAbi } from "viem";
import { connect } from "../lib/mcp.mjs";
import { EXPLORER_API, addrLink, read, readAgreed } from "../lib/pharos.mjs";
import { IRM_ABI, MORPHO_ABI, ORACLE_ABI, accruedTotalBorrow, health, level, repairs, shouldAlert } from "./morpho.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cmd = args[0];
const cfg = JSON.parse(readFileSync(opt("--config", new URL("./positions.json", import.meta.url)), "utf8"));
const MORPHO = cfg.morpho.toLowerCase();
const statePath = opt("--state", new URL("./state.json", import.meta.url));
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const mcp = await connect();
const tokens = {};
const token = async (a) => (tokens[a] ??= { symbol: await read(mcp, a, erc20Abi, "symbol"), decimals: Number(await read(mcp, a, erc20Abi, "decimals")) });
const params = {};
const marketParams = async (id) => (params[id] ??= await read(mcp, MORPHO, MORPHO_ABI, "idToMarketParams", [id]));
const amt = (raw, t, dp = 2) => Number(formatUnits(raw, t.decimals)).toLocaleString("en-US", { maximumFractionDigits: dp });

/** Everything about one position at block `block`. */
async function inspect(p, block, now) {
  const mp = await marketParams(p.market);
  const [loanToken, collToken, oracle, irm, lltv] = mp;
  const [loan, coll] = [await token(loanToken), await token(collToken)];
  const pos = await readAgreed(mcp, MORPHO, MORPHO_ABI, "position", [p.market, p.borrower], block);
  const mk = await readAgreed(mcp, MORPHO, MORPHO_ABI, "market", [p.market], block);
  const price = await readAgreed(mcp, oracle, ORACLE_ABI, "price", [], block);
  const rate = /^0x0+$/.test(irm) ? 0n : await read(mcp, irm, IRM_ABI, "borrowRateView", [mp, mk], block);
  const totalBorrow = accruedTotalBorrow(mk[2], mk[4], now, rate);
  const h = health({ borrowShares: pos[1], collateral: pos[2], totalBorrowAssets: totalBorrow, totalBorrowShares: mk[3], price, lltv });
  const th = { ...cfg.defaults, ...(cfg.markets?.[p.market] ?? {}), ...(p.thresholds ?? {}) };
  const fix = repairs(h, { collateral: pos[2], price, lltv, target: th.target });
  return { p, loan, coll, lltv, rate, collateral: pos[2], h, th, fix, level: level(h.hf, th) };
}

function describe(x) {
  const { loan, coll, h, th, fix } = x;
  const pair = `${coll.symbol}/${loan.symbol}`;
  const hf = h.hf === Infinity ? "∞ (no debt)" : h.hf.toFixed(4);
  const head = `${x.level.toUpperCase()} ${pair} ${x.p.label ?? ""} — borrower ${short(x.p.borrower)}: health factor ${hf}`;
  const lines = [
    head,
    `  thresholds: warn < ${th.warn}, critical < ${th.critical}, liquidation < 1.0 (LLTV ${Number(x.lltv) / 1e16}%)`,
    `  collateral ${amt(x.collateral, coll)} ${coll.symbol} (= ${amt(h.collateralValue, loan)} ${loan.symbol} at the market oracle); ` +
      `debt ${amt(h.borrowed, loan)} ${loan.symbol} incl. interest (${((Number(x.rate) * 31536000) / 1e16).toFixed(2)}% APR)`,
  ];
  if (fix) {
    lines.push(`  liquidation if ${coll.symbol} falls ${fix.dropToLiquidationPct.toFixed(2)}% against ${loan.symbol}`);
    if (x.level !== "ok")
      lines.push(`  action: repay ${amt(fix.repay, loan)} ${loan.symbol}, or add ${amt(fix.addCollateral, coll)} ${coll.symbol} of collateral, to get back to HF ${th.target}`);
  }
  lines.push(`  ${addrLink(x.p.borrower)}`);
  return lines.join("\n");
}

async function telegram(text) {
  const { TELEGRAM_BOT_TOKEN: t, TELEGRAM_CHAT_ID: chat } = process.env;
  const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${body.error_code}: ${body.description}`);
}
const useTelegram = !args.includes("--console") && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;

async function pass(state) {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  console.log(`${stamp()} block ${block}: ${cfg.positions.length} position(s)`);
  for (const p of cfg.positions) {
    const x = await inspect(p, block, now);
    const key = `${p.market}:${p.borrower.toLowerCase()}`;
    const why = shouldAlert(state[key], x.level, now, (cfg.repeatCriticalHours ?? 6) * 3600);
    console.log(`  ${x.level.padEnd(12)} HF ${x.h.hf === Infinity ? "∞" : x.h.hf.toFixed(4)}  ${x.coll.symbol}/${x.loan.symbol} ${short(p.borrower)}${why ? `  → alert (${why})` : ""}`);
    if (!why) continue;
    const text = `${why === "better" ? "Recovered: " : why === "reminder" ? "Still at risk: " : ""}${describe(x)}\n  (block ${block})`;
    if (useTelegram) await telegram(text);
    console.log(`${stamp()} ALERT${useTelegram ? " → Telegram" : ""}\n${text}`);
    state[key] = { level: x.level, hf: x.h.hf, alertedAt: now, block };
  }
  writeFileSync(statePath, JSON.stringify(state, null, 1));
}

/**
 * Find live borrow positions: transactions and token transfers of the Morpho contract from the explorer,
 * their receipts through Chain MCP, Borrow/SupplyCollateral events → (market, borrower), then the current
 * position of each. Prints those with debt, riskiest first.
 */
async function discover() {
  const EV = parseAbi([
    "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
    "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)",
  ]);
  const hashes = new Set();
  for (const kind of ["transactions", "token_transfers"]) {
    for (let page = 1; ; page++) {
      const d = await (await fetch(`${EXPLORER_API}/address/${MORPHO}/${kind}?size=50&page=${page}`)).json();
      d.data.forEach((t) => hashes.add(t.hash ?? t.transaction_hash));
      if (d.data.length < 50) break;
    }
  }
  console.log(`${stamp()} ${hashes.size} transactions touch ${MORPHO}; reading receipts through Chain MCP`);
  const pairs = new Set();
  for (const h of hashes) {
    const r = await mcp.call("get_transaction_receipt", { hash: h });
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== MORPHO) continue;
      try {
        const e = decodeEventLog({ abi: EV, data: l.data, topics: l.topics });
        pairs.add(`${e.args.id}|${e.args.onBehalf.toLowerCase()}`);
      } catch {}
    }
  }
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  const found = [];
  for (const pr of pairs) {
    const [market, borrower] = pr.split("|");
    const x = await inspect({ market, borrower }, block, now);
    if (x.h.borrowed > 0n) found.push({ market, borrower, pair: `${x.coll.symbol}/${x.loan.symbol}`, hf: x.h.hf, debt: amt(x.h.borrowed, x.loan, 0) });
  }
  found.sort((a, b) => a.hf - b.hf);
  console.log(`${stamp()} block ${block}: ${found.length} positions with debt (of ${pairs.size} market/borrower pairs)`);
  for (const f of found) console.log(`  HF ${f.hf.toFixed(4).padStart(12)}  ${f.pair.padEnd(13)} debt ${f.debt.padStart(10)}  ${f.borrower}  ${f.market}`);
  writeFileSync(new URL("./discovered.json", import.meta.url), JSON.stringify({ block, found }, null, 1));
}

try {
  if (cmd === "discover") await discover();
  else if (cmd === "check" || cmd === "watch") {
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const stopAt = opt("--for", null) ? Date.now() + Number(opt("--for")) * 1000 : 0;
    for (;;) {
      await pass(state);
      if (cmd === "check" || Date.now() >= stopAt && stopAt) break;
      await new Promise((r) => setTimeout(r, Number(opt("--interval", "60")) * 1000));
    }
  } else {
    console.log("usage: watchdog.mjs discover | check | watch [--config c.json] [--interval s] [--for s] [--console]");
    process.exitCode = 2;
  }
} finally {
  await mcp.close();
}
