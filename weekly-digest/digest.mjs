#!/usr/bin/env node
// Weekly Digest Agent (Pharos Agent Arena, Medium): a periodic summary of a DEX pool on Pharos mainnet —
// key numbers against the previous period, the top 3 notable events — delivered to Telegram and published
// as a Markdown page in this repo.
//
//   node --env-file=.env weekly-digest/digest.mjs run      [--config c.json] [--no-send]   last complete period
//   node --env-file=.env weekly-digest/digest.mjs schedule [--config c.json] [--for seconds] run on schedule
//
// Periods are [anchor + k·period, anchor + (k+1)·period), weekly from a Monday 00:00 UTC by default.
// All chain data comes from Chain MCP: block timestamps (get_block), Swap/Mint/Burn logs (get_logs, 1,000
// blocks per call), and the pool's end-of-period state (eth_call at a pinned block, two agreeing reads).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, erc20Abi, parseAbi, toEventSelector } from "viem";
import { connect } from "../lib/mcp.mjs";
import { TOKENS, addrLink, readAgreed, txLink } from "../lib/pharos.mjs";
import { change, fmt, lastCompleteStart, notable, priceOf, summarize } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cmd = args[0];
const cfg = JSON.parse(readFileSync(opt("--config", join(here, "digest.json")), "utf8"));
const stateDir = resolve(here, cfg.stateDir ?? "state");
const pagesDir = resolve(here, cfg.pagesDir ?? "digests");
mkdirSync(stateDir, { recursive: true });
mkdirSync(pagesDir, { recursive: true });

const POOL_EVENTS = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);
const TOPICS = POOL_EVENTS.map((e) => toEventSelector(e));
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);

const UNIT = { m: 60, h: 3600, d: 86400 };
const periodSec = (() => {
  const m = /^(\d+)([mhd])$/.exec(cfg.period ?? "7d");
  if (!m) throw new Error(`period must look like 7d, 1d, 6h or 30m; got ${cfg.period}`);
  return Number(m[1]) * UNIT[m[2]];
})();
const anchor = Date.parse(cfg.anchor ?? "2026-10-05T00:00:00Z") / 1000; // a Monday
const pool = cfg.pool.toLowerCase();
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const iso = (s) => new Date(s * 1000).toISOString().replace(".000", "");

/** Start time of the last period that has fully ended at `now`. */
const lastComplete = (now) => lastCompleteStart(now, anchor, periodSec);

let mcp;
let meta;

async function blockAt(t) {
  // First block with timestamp >= t (binary search over get_block).
  const ts = async (n) => {
    const b = await mcp.call("get_block", { block: String(n) });
    // An unknown argument is ignored and the latest block comes back, so check we got the one we asked for.
    if (Number(BigInt(b.number)) !== n) throw new Error(`get_block(${n}) returned block ${Number(BigInt(b.number))}`);
    return Number(BigInt(b.timestamp));
  };
  let hi = Number((await mcp.call("get_block_number")).blockNumber);
  const headTs = await ts(hi);
  if (t > headTs) throw new Error(`period ends after the chain head (${iso(t)} > ${iso(headTs)})`);
  let lo = Math.max(1, hi - (headTs - t) * 2 - 10_000);
  while ((await ts(lo)) >= t) lo = Math.max(1, lo - 100_000);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((await ts(mid)) >= t) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function loadMeta() {
  const [t0, t1] = [await readAgreedLatest("token0"), await readAgreedLatest("token1")].map((a) => a.toLowerCase());
  const m0 = TOKENS[t0], m1 = TOKENS[t1];
  return { t0, t1, sym0: m0.symbol, sym1: m1.symbol, dec0: m0.decimals, dec1: m1.decimals };
}
async function readAgreedLatest(fn) {
  const head = Number((await mcp.call("get_block_number")).blockNumber);
  return readAgreed(mcp, pool, POOL_ABI, fn, [], head);
}

async function fetchEvents(from, to) {
  const out = [];
  const total = to - from + 1;
  for (let b = from; b <= to; b += 1000) {
    const end = Math.min(to, b + 999);
    const res = await mcp.call("get_logs", { address: pool, topics: [TOPICS], fromBlock: String(b), toBlock: String(end) });
    for (const log of Array.isArray(res) ? res : res.logs ?? []) {
      const { eventName, args: a } = decodeEventLog({ abi: POOL_EVENTS, data: log.data, topics: log.topics });
      out.push({
        kind: eventName.toLowerCase(),
        block: Number(BigInt(log.blockNumber)),
        time: Number(BigInt(log.blockTimestamp)),
        tx: log.transactionHash,
        amount0: a.amount0,
        amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96,
        recipient: a.recipient?.toLowerCase(),
      });
    }
    if (((b - from) / 1000) % 100 === 0) process.stdout.write(`  ${Math.round(((end - from + 1) / total) * 100)}%`);
  }
  process.stdout.write("\n");
  return out;
}

/** Metrics for one period, cached in state/<start>.json so the next digest reuses it as "previous". */
async function period(start) {
  const file = join(stateDir, `period-${iso(start).replace(/:/g, "")}-${cfg.period}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const end = start + periodSec;
  console.log(`${stamp()} period ${iso(start)} → ${iso(end)}: finding blocks`);
  const [b0, b1] = [await blockAt(start), await blockAt(end)];
  console.log(`${stamp()}   blocks ${b0} … ${b1 - 1}: reading Swap/Mint/Burn logs (${Math.ceil((b1 - b0) / 1000)} get_logs calls)`);
  const events = await fetchEvents(b0, b1 - 1);
  const last = b1 - 1;
  const [slot0, r0, r1] = [
    await readAgreed(mcp, pool, POOL_ABI, "slot0", [], last),
    await readAgreed(mcp, meta.t0, erc20Abi, "balanceOf", [pool], last),
    await readAgreed(mcp, meta.t1, erc20Abi, "balanceOf", [pool], last),
  ];
  const closeState = priceOf(slot0[0], meta.dec0, meta.dec1);
  const reserve0 = Number(r0) / 10 ** meta.dec0, reserve1 = Number(r1) / 10 ** meta.dec1;
  const p = {
    start: iso(start), end: iso(end), firstBlock: b0, lastBlock: last, events: events.length,
    ...summarize(events, meta),
    endState: { block: last, price: closeState, reserve0, reserve1, tvlUsd: reserve1 + reserve0 * closeState },
    notable: notable(events, meta).map((n) => ({ ...n, link: n.tx ? txLink(n.tx) : null })),
  };
  writeFileSync(file, JSON.stringify(p, null, 1));
  return p;
}

function render(cur, prev, html) {
  const rows = [
    ["Swaps", cur.swaps, prev?.swaps, (x) => fmt(x)],
    ["Volume (USD)", cur.volumeUsd, prev?.volumeUsd, (x) => "$" + fmt(x)],
    ["Distinct swap recipients", cur.traders, prev?.traders, (x) => fmt(x)],
    ["Median swap (USD)", cur.medianSwapUsd, prev?.medianSwapUsd, (x) => "$" + fmt(x)],
    [`${meta.sym0} close (${meta.sym1})`, cur.price?.close, prev?.price?.close, (x) => x.toFixed(4)],
    [`Net ${meta.sym0} bought by traders`, cur.netBought0, prev?.netBought0, (x) => fmt(x)],
    ["Liquidity added (USD)", cur.liquidityAddedUsd, prev?.liquidityAddedUsd, (x) => "$" + fmt(x)],
    ["Liquidity removed (USD)", cur.liquidityRemovedUsd, prev?.liquidityRemovedUsd, (x) => "$" + fmt(x)],
    ["TVL at period end (USD)", cur.endState.tvlUsd, prev?.endState.tvlUsd, (x) => "$" + fmt(x)],
  ];
  const pct = (a, b) => {
    const c = change(a, b);
    if (c == null) return "n/a";
    const s = c.toFixed(1);
    return s === "0.0" || s === "-0.0" ? "0.0%" : `${c > 0 ? "+" : ""}${s}%`;
  };
  const range = `${cur.start.slice(0, 10)} → ${cur.end.slice(0, 10)} (UTC, ${cfg.period})`;
  if (html) {
    const lines = rows.map(([k, a, b, f]) => `${k}: <b>${f(a ?? 0)}</b> (${pct(a, b)})`);
    const top = cur.notable.map((n, i) => `${i + 1}. ${n.text}${n.link ? ` — <a href="${n.link}">tx</a>` : ""}`);
    return `<b>${meta.sym0}/${meta.sym1} pool digest</b>\n${range}\n\n${lines.join("\n")}\n\n<b>Top 3</b>\n${top.join("\n")}\n\n<a href="${cfg.pageUrlBase}/${pageName(cur)}">Full page</a>`;
  }
  const table = rows.map(([k, a, b, f]) => `| ${k} | ${a == null ? "–" : f(a)} | ${b == null ? "–" : f(b)} | ${pct(a, b)} |`);
  return [
    `# ${meta.sym0}/${meta.sym1} pool — digest ${range}`,
    "",
    `Pool [\`${pool}\`](${addrLink(pool)}) on Pharos mainnet. This period: blocks ${cur.firstBlock}–${cur.lastBlock}, ${cur.events} pool events.`,
    "",
    `| Metric | This period | Previous (${prev?.start.slice(0, 10) ?? "–"}) | Change |`,
    "|---|---:|---:|---:|",
    ...table,
    "",
    `Price range this period: low ${cur.price?.low.toFixed(4)}, high ${cur.price?.high.toFixed(4)} ${meta.sym1} per ${meta.sym0}. ` +
      `End-of-period reserves (block ${cur.endState.block}): ${fmt(cur.endState.reserve0)} ${meta.sym0}, ${fmt(cur.endState.reserve1)} ${meta.sym1}.`,
    "",
    "## Top 3 notable events",
    "",
    ...cur.notable.map((n, i) => `${i + 1}. ${n.text} (${iso(n.time).replace("T", " ")}${n.link ? `, [tx](${n.link})` : ""}). Score ${n.score.toFixed(1)}.`),
    "",
    "Notable = how unusual an event is for this period: its size divided by the period's own median of the same kind",
    "(swap size, liquidity change, one-hour price move, daily volume). At most one swap, unless too few other candidates.",
    "",
    `Generated ${stamp()} from Chain MCP (get_block, get_logs, eth_call). Distinct swap recipients counts the`,
    "Swap event's recipient, which is the trader's address for direct swaps and a router for multi-hop ones.",
    "",
  ].join("\n");
}

// One page per period: the date for daily or longer periods, date and time for shorter ones.
const pageName = (p) => `${periodSec >= 86400 ? p.start.slice(0, 10) : p.start.slice(0, 16).replace(":", "")}_${cfg.period}.md`;

async function telegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${body.error_code}: ${body.description}`);
}

const sentPath = join(stateDir, "sent.json");
const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, "utf8")) : {};

/** Build and deliver the digest for the period starting at `start`, once. */
async function digest(start, send) {
  const key = `${iso(start)}/${cfg.period}`;
  const cur = await period(start);
  const prev = await period(start - periodSec);
  const page = join(pagesDir, pageName(cur));
  writeFileSync(page, render(cur, prev, false));
  console.log(`${stamp()} page written: ${page}`);
  if (!send) return console.log(render(cur, prev, false));
  if (sent[key]) return console.log(`${stamp()} ${key} already delivered at ${sent[key]}; not sending again`);
  await telegram(render(cur, prev, true));
  sent[key] = stamp();
  writeFileSync(sentPath, JSON.stringify(sent, null, 1));
  console.log(`${stamp()} delivered ${key} to Telegram`);
}

mcp = await connect();
try {
  meta = await loadMeta();
  if (cmd === "run") {
    await digest(lastComplete(Date.now() / 1000), !args.includes("--no-send"));
  } else if (cmd === "schedule") {
    const stopAt = opt("--for", null) ? Date.now() + Number(opt("--for")) * 1000 : Infinity;
    console.log(`${stamp()} scheduler: every ${cfg.period} from ${iso(anchor)}; delivers each completed period once`);
    for (;;) {
      const due = lastComplete(Date.now() / 1000);
      if (!sent[`${iso(due)}/${cfg.period}`]) await digest(due, true);
      const next = (due + 2 * periodSec) * 1000 + 30_000; // 30 s after the current period ends
      console.log(`${stamp()} next digest due at ${new Date(next).toISOString()}`);
      if (next > stopAt) break;
      await new Promise((r) => setTimeout(r, next - Date.now()));
    }
  } else {
    console.log("usage: digest.mjs run|schedule [--config c.json] [--no-send] [--for seconds]");
    process.exitCode = 2;
  }
} finally {
  await mcp.close();
}
