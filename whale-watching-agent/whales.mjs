#!/usr/bin/env node
// Whale-Watching Agent (Pharos Agent Arena, Medium): track a list of addresses and report their significant
// moves, with what moved, how much, where to, and why it matters.
//
//   node whale-watching-agent/whales.mjs scan  [--config whales.json] [--hours 6]      summary of a window
//   node whale-watching-agent/whales.mjs watch [--config whales.json] [--interval 15] [--for seconds]  live, new blocks only
//
// Token moves: Chain MCP get_logs on the ERC-20 Transfer event, filtered by token addresses and by
// from-or-to in the watch list (2 queries per 1,000 blocks for all tokens and addresses). USD values:
// Chainlink feeds read through Chain MCP. PROS (native) moves: the explorer's per-address list, since native
// transfers emit no log.
import { readFileSync } from "node:fs";
import { erc20Abi, pad, toEventSelector } from "viem";
import { connect } from "../lib/mcp.mjs";
import { EXPLORER_API, LABELS, TOKENS, human, read, readFeed, short, txLink } from "../lib/pharos.mjs";
import { WPROS_USDC_POOL } from "../lib/pool.mjs";

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const ROUTER = "0x974d1cf6ffa4fce5a4d62955afc02f45aac29f35";
const FEED_OF = { PROS: "PROS/USD", WPROS: "PROS/USD", USDC: "USDC/USD", WETH: "ETH/USD", LINK: "LINK/USD" };
const KNOWN = {
  ...LABELS,
  [WPROS_USDC_POOL]: "the WPROS/USDC DEX pool",
  [ROUTER]: "a DEX router",
};
const DEX = new Set([WPROS_USDC_POOL, ROUTER]);
const tokenMeta = new Map(Object.entries(TOKENS)); // filled lazily with tokens met in receipts

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const mode = args[0];
const cfg = JSON.parse(readFileSync(opt("--config", new URL("./whales.json", import.meta.url)), "utf8"));
const watched = Object.fromEntries(cfg.watch.map((w) => [w.address.toLowerCase(), w.label]));
const minUsd = cfg.thresholds?.usd ?? 500;
const perToken = cfg.thresholds?.tokens ?? {};
const nameOf = (a) => (watched[a] ? `${watched[a]} (${short(a)})` : KNOWN[a] ? `${KNOWN[a]} (${short(a)})` : short(a));

const mcp = await connect();
const prices = {};
for (const sym of Object.keys(FEED_OF)) prices[sym] ??= (await readFeed(mcp, FEED_OF[sym])).price;

if (mode === "scan") {
  const head = Number((await mcp.call("get_block_number")).blockNumber);
  const hours = Number(opt("--hours", "6"));
  const from = head - Math.round(hours * 3600); // ~1 s blocks
  const moves = await collect(from, head, Date.now() / 1000 - hours * 3600);
  printMoves(moves);
  printSummary(moves, hours);
} else if (mode === "watch") {
  let next = Number((await mcp.call("get_block_number")).blockNumber);
  const seen = new Set();
  console.log(`watching ${cfg.watch.length} addresses from block ${next}; significant = ≥ $${minUsd} or token thresholds ${JSON.stringify(perToken)}\n`);
  const stopAt = opt("--for", null) ? Date.now() + Number(opt("--for")) * 1000 : Infinity;
  while (Date.now() < stopAt) {
    const head = Number((await mcp.call("get_block_number")).blockNumber);
    if (head >= next) {
      const moves = (await collect(next, head, Date.now() / 1000 - 120)).filter((m) => !seen.has(m.id));
      moves.forEach((m) => seen.add(m.id));
      printMoves(moves);
      next = head + 1;
    }
    await new Promise((r) => setTimeout(r, Number(opt("--interval", "15")) * 1000));
  }
  console.log(`stopped at block ${next - 1}`);
}
await mcp.close();

/** All significant moves of watched addresses between blocks [from, to]. */
async function collect(from, to, sinceUnix) {
  const tokens = Object.keys(TOKENS);
  const addrs = Object.keys(watched).map((a) => pad(a));
  const legs = [];
  for (let a = from; a <= to; a += 1000) {
    const b = Math.min(to, a + 999);
    for (const topics of [[TRANSFER, addrs], [TRANSFER, null, addrs]]) {
      const logs = await mcp.call("get_logs", { address: tokens, topics, fromBlock: String(a), toBlock: String(b) });
      for (const l of logs) {
        if (l.topics.length !== 3) continue;
        const t = TOKENS[l.address.toLowerCase()];
        const src = "0x" + l.topics[1].slice(26), dst = "0x" + l.topics[2].slice(26);
        legs.push({ tx: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), block: Number(BigInt(l.blockNumber)), time: Number(BigInt(l.blockTimestamp ?? "0x0")), symbol: t.symbol, decimals: t.decimals, amount: BigInt(l.data), from: src, to: dst });
      }
    }
  }
  // Native PROS from the explorer (no logs for native value).
  for (const w of Object.keys(watched)) {
    const r = await fetch(`${EXPLORER_API}/address/${w}/transactions?size=50&page=1`, { signal: AbortSignal.timeout(30000) }).then((x) => x.json()).catch(() => ({ data: [] }));
    for (const t of r.data ?? []) {
      const time = Date.parse(t.block_timestamp) / 1000;
      if (time < sinceUnix || t.block_number < from || t.block_number > to || t.receipt_status !== 1) continue;
      const v = BigInt(Math.round(Number(t.value) * 1e6)) * 10n ** 12n;
      if (v > 0n) legs.push({ tx: t.hash, logIndex: -1, block: t.block_number, time, symbol: "PROS", decimals: 18, amount: v, from: t.from_address.toLowerCase(), to: (t.to_address ?? "").toLowerCase() });
    }
  }
  // De-duplicate (a leg between two watched addresses is returned by both queries), then group per (tx, watched address).
  const uniq = [...new Map(legs.map((l) => [`${l.tx}:${l.logIndex}:${l.symbol}`, l])).values()];
  const groups = new Map();
  for (const l of uniq) {
    for (const w of [l.from, l.to]) {
      if (!watched[w]) continue;
      const k = `${l.tx}:${w}`;
      if (!groups.has(k)) groups.set(k, { id: k, tx: l.tx, block: l.block, time: l.time, whale: w, legs: [] });
      groups.get(k).legs.push(l);
    }
  }
  const moves = [];
  for (const g of groups.values()) {
    const out = g.legs.filter((l) => l.from === g.whale), inn = g.legs.filter((l) => l.to === g.whale);
    const usd = (l) => (Number(l.amount) / 10 ** l.decimals) * (prices[l.symbol] ?? 0);
    const value = Math.max(out.reduce((s, l) => s + usd(l), 0), inn.reduce((s, l) => s + usd(l), 0));
    const tokenHit = g.legs.some((l) => perToken[l.symbol] !== undefined && Number(l.amount) / 10 ** l.decimals >= perToken[l.symbol]);
    if (value < minUsd && !tokenHit) continue;
    // Significant: read the whole receipt to see every token the wallet moved in this tx (vault shares, LP
    // tokens and other tokens outside the watched list), and which contract it called.
    const full = await enrich(g);
    moves.push({ ...g, out, inn, usd: value, called: full.called, story: explain(g.whale, full.out.length ? full.out : out, full.inn.length ? full.inn : inn, full.called) });
  }
  return moves.sort((a, b) => a.block - b.block);
}

async function meta(addr) {
  if (!tokenMeta.has(addr)) {
    try {
      const [symbol, decimals] = await Promise.all([read(mcp, addr, erc20Abi, "symbol"), read(mcp, addr, erc20Abi, "decimals")]);
      tokenMeta.set(addr, { symbol, decimals: Number(decimals) });
    } catch {
      tokenMeta.set(addr, { symbol: short(addr), decimals: 18 });
    }
  }
  return tokenMeta.get(addr);
}

/** Every ERC-20 leg of the wallet in this transaction, from the receipt (Chain MCP), plus the contract called. */
async function enrich(g) {
  const [tx, rc] = await Promise.all([mcp.call("get_transaction", { hash: g.tx }), mcp.call("get_transaction_receipt", { hash: g.tx })]);
  const out = [], inn = [];
  for (const l of rc.logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue;
    const src = "0x" + l.topics[1].slice(26), dst = "0x" + l.topics[2].slice(26);
    if (src !== g.whale && dst !== g.whale) continue;
    const m = await meta(l.address.toLowerCase());
    const leg = { symbol: m.symbol, decimals: m.decimals, token: l.address.toLowerCase(), amount: BigInt(l.data), from: src, to: dst };
    (src === g.whale ? out : inn).push(leg);
  }
  const called = tx.from.toLowerCase() === g.whale && tx.input !== "0x" ? tx.to?.toLowerCase() : null;
  return { out, inn, called };
}

/** What happened and why it matters, in one or two sentences. */
function explain(w, out, inn, called) {
  const fmt = (l) => `${human(l.amount, l.decimals, 2)} ${l.symbol}`;
  const sum = (ls) => ls.map(fmt).join(" + ");
  const cps = [...new Set([...out.map((l) => l.to), ...inn.map((l) => l.from)])];
  const viaDex = cps.some((c) => DEX.has(c));
  const mintedToWallet = inn.filter((l) => l.from === ZERO && !TOKENS[l.token]);
  const burnedFromWallet = out.filter((l) => l.to === ZERO && !TOKENS[l.token]);
  if (called && !DEX.has(called) && out.length && mintedToWallet.length) {
    return { what: `deposited ${sum(out.filter((l) => l.to !== ZERO))} into contract ${nameOf(called)} and received ${sum(mintedToWallet)} (newly minted shares)`, why: "Capital going into a protocol or vault: it stays on Pharos, now earning or locked, and the wallet holds a claim (the share token) instead." };
  }
  if (called && !DEX.has(called) && inn.length && burnedFromWallet.length) {
    return { what: `withdrew ${sum(inn.filter((l) => l.from !== ZERO))} from contract ${nameOf(called)}, burning ${sum(burnedFromWallet)} shares`, why: "Capital leaving a protocol or vault: the wallet is taking liquidity out, which can precede a sell or a bridge out." };
  }
  if (out.length && inn.length && out.some((o) => !inn.some((i) => i.symbol === o.symbol))) {
    return { what: `swapped ${sum(out)} for ${sum(inn)}${viaDex ? " on the WPROS/USDC pool" : ""}`, why: inn.some((l) => l.symbol === "USDC") ? "Selling into stablecoins: a large holder reducing exposure." : "Buying with stablecoins: a large holder adding exposure." };
  }
  if (out.length) {
    const to = out[0].to;
    if (to === ZERO) {
      return out[0].symbol === "USDC"
        ? { what: `burned ${sum(out)}`, why: "USDC burned: typically bridged out to another chain (Circle CCTP). Money leaving Pharos." }
        : { what: `unwrapped/burned ${sum(out)}`, why: out[0].symbol === "WPROS" ? "WPROS unwrapped back to native PROS." : "Tokens burned; supply went down." };
    }
    if (DEX.has(to)) return { what: `sent ${sum(out)} into ${nameOf(to)}`, why: "Sending into a DEX usually means selling; watch the price." };
    if (watched[to]) return { what: `moved ${sum(out)} to ${nameOf(to)}`, why: "Internal move between watched wallets: no net change for the group." };
    return { what: `sent ${sum(out)} to ${nameOf(to)}`, why: "Funds left the wallet to another address: could be a payment, an exchange deposit or a move to another wallet of the same owner." };
  }
  const fromA = inn[0].from;
  if (fromA === ZERO) {
    return inn[0].symbol === "USDC"
      ? { what: `received ${sum(inn)} newly minted`, why: "Fresh USDC minted to this wallet: typically bridged in from another chain (Circle CCTP) or issued by Circle. New money arriving on Pharos." }
      : { what: `wrapped/minted ${sum(inn)}`, why: inn[0].symbol === "WPROS" ? "PROS wrapped into WPROS, usually right before trading or depositing it." : "New tokens created for this wallet." };
  }
  if (DEX.has(fromA)) return { what: `received ${sum(inn)} from ${nameOf(fromA)}`, why: "Coming out of a DEX usually means buying." };
  return { what: `received ${sum(inn)} from ${nameOf(fromA)}`, why: watched[fromA] ? "Internal move between watched wallets." : "New funds came in: the wallet may be preparing to trade or deploy them." };
}

function printMoves(moves) {
  for (const m of moves) {
    const t = m.time ? new Date(m.time * 1000).toISOString().replace("T", " ").slice(0, 16) : `block ${m.block}`;
    console.log(`[${t}] ${nameOf(m.whale)} ${m.story.what}  (~$${Math.round(m.usd).toLocaleString("en-US")})`);
    console.log(`    why it matters: ${m.story.why}`);
    console.log(`    ${txLink(m.tx)}`);
  }
}

function printSummary(moves, hours) {
  console.log(`\n=== Summary: last ${hours} h, ${moves.length} significant move(s), threshold $${minUsd}, prices from Chainlink via Chain MCP ===`);
  console.log(`  PROS $${prices.PROS.toFixed(4)}  USDC $${prices.USDC.toFixed(4)}  ETH $${prices.WETH.toFixed(2)}  LINK $${prices.LINK.toFixed(2)}\n`);
  console.log(`  ${"Address".padEnd(44)} ${"moves".padStart(5)} ${"in (USD)".padStart(12)} ${"out (USD)".padStart(12)}  last move`);
  for (const [a, lbl] of Object.entries(watched)) {
    const mine = moves.filter((m) => m.whale === a);
    const usd = (ls) => ls.reduce((s, l) => s + (Number(l.amount) / 10 ** l.decimals) * (prices[l.symbol] ?? 0), 0);
    const inn = mine.reduce((s, m) => s + usd(m.inn), 0), out = mine.reduce((s, m) => s + usd(m.out), 0);
    const last = mine.at(-1);
    console.log(`  ${`${lbl} (${short(a)})`.padEnd(44)} ${String(mine.length).padStart(5)} ${Math.round(inn).toLocaleString("en-US").padStart(12)} ${Math.round(out).toLocaleString("en-US").padStart(12)}  ${last ? last.story.what.slice(0, 60) : "—"}`);
  }
  // Patterns across wallets: several watched wallets calling the same contract in the window.
  const byContract = new Map();
  for (const m of moves) if (m.called) byContract.set(m.called, [...(byContract.get(m.called) ?? []), m]);
  for (const [c, ms] of byContract) {
    const who = new Set(ms.map((m) => m.whale));
    if (who.size < 2) continue;
    const total = ms.reduce((s, m) => s + m.usd, 0);
    const span = (Math.max(...ms.map((m) => m.time)) - Math.min(...ms.map((m) => m.time))) / 3600;
    const bridged = ms.filter((m) => moves.some((x) => x.whale === m.whale && x.time <= m.time && /newly minted/.test(x.story.what))).length;
    console.log(`
  Pattern: ${who.size} of ${Object.keys(watched).length} watched wallets called contract ${nameOf(c)} within ${span.toFixed(1)} h, ~$${Math.round(total).toLocaleString("en-US")} in total${bridged ? `; ${bridged} of them had just received freshly minted USDC` : ""}. Coordinated flow into one protocol: worth checking what that contract is.`);
  }
  const top = [...moves].sort((a, b) => b.usd - a.usd).slice(0, 3);
  if (top.length) {
    console.log(`\n  Largest moves:`);
    for (const m of top) console.log(`  - $${Math.round(m.usd).toLocaleString("en-US")}: ${nameOf(m.whale)} ${m.story.what}`);
  }
}
