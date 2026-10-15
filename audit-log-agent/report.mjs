#!/usr/bin/env node
// Audit-Log Agent (Pharos Agent Arena, Medium): a plain-language activity report for one wallet over a
// date range, of the kind a compliance officer or accountant can read.
//
//   node audit-log-agent/report.mjs --wallet 0x… --from 2026-10-01 --to 2026-10-15 [--out dir] [--max 400]
//
// Discovery: the Pharos explorer API lists the transaction hashes that touch the wallet in the range.
// Facts: every transaction and receipt is then read through Chain MCP (get_transaction,
// get_transaction_receipt), and token symbols/decimals through Chain MCP eth_call. Classification is done
// locally from the raw receipt logs, not from the explorer's labels.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, erc20Abi, parseAbi, toEventSelector } from "viem";
import { connect, MCP_URL } from "../lib/mcp.mjs";
import { EXPLORER_API, NATIVE, TOKENS, addrLink, human, label, read, txLink } from "../lib/pharos.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const wallet = opt("--wallet")?.toLowerCase();
const from = opt("--from");
const to = opt("--to");
const outDir = opt("--out", "audit-log-agent/out");
const max = Number(opt("--max", "400"));
if (!/^0x[0-9a-f]{40}$/.test(wallet ?? "") || !from || !to) {
  console.error("usage: report.mjs --wallet 0x… --from YYYY-MM-DD --to YYYY-MM-DD [--out dir] [--max N]");
  process.exit(2);
}
const start = new Date(`${from}T00:00:00Z`);
const end = new Date(`${to}T23:59:59Z`);

// Topics computed from the event signatures (never hand-typed).
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const SWAP_TOPICS = {
  [toEventSelector("Swap(address,uint256,uint256,uint256,uint256,address)")]: "Uniswap V2-style",
  [toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)")]: "Uniswap V3-style",
};
const WITHDRAW = parseAbi(["event Withdrawal(address indexed src, uint256 wad)", "event Deposit(address indexed dst, uint256 wad)"]);
const MAX_UINT = 2n ** 256n - 1n;
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

// ─────────────────────────── discovery (explorer API) ───────────────────────────

async function page(kind, p) {
  const url = `${EXPLORER_API}/address/${wallet}/${kind}?size=50&page=${p}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`explorer ${kind} page ${p}: HTTP ${r.status}`);
  return r.json();
}

async function discover() {
  const hashes = new Map(); // hash -> timestamp
  for (const kind of ["transactions", "token_transfers"]) {
    for (let p = 1; ; p++) {
      const { data } = await page(kind, p);
      if (!data?.length) break;
      let older = false;
      for (const row of data) {
        const t = new Date(row.block_timestamp);
        if (t > end) continue;
        if (t < start) {
          older = true;
          continue;
        }
        hashes.set(row.hash ?? row.transaction_hash, t);
      }
      if (older || data.length < 50) break;
    }
  }
  return [...hashes.entries()].sort((a, b) => a[1] - b[1]).map(([hash]) => hash);
}

// ─────────────────────────── facts (Chain MCP) ───────────────────────────

const tokenCache = new Map(Object.entries(TOKENS));
async function token(mcp, address) {
  if (!tokenCache.has(address)) {
    let meta = { symbol: short(address), decimals: 18, unknown: true };
    try {
      const [symbol, decimals] = await Promise.all([
        read(mcp, address, erc20Abi, "symbol"),
        read(mcp, address, erc20Abi, "decimals"),
      ]);
      meta = { symbol, decimals: Number(decimals) };
    } catch {
      // not an ERC-20 we can read; keep raw units
    }
    tokenCache.set(address, meta);
  }
  return tokenCache.get(address);
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function load(mcp, hash) {
  const [tx, rc] = await Promise.all([
    mcp.call("get_transaction", { hash }),
    mcp.call("get_transaction_receipt", { hash }),
  ]);
  return { tx, rc };
}

// ─────────────────────────── classification ───────────────────────────

/** Net token/native flows for the wallet in one tx, plus approvals it granted. */
async function analyse(mcp, { tx, rc }) {
  const flows = []; // { symbol, decimals, token, amount (signed bigint), counterparty }
  const approvals = [];
  const ownTx = tx.from.toLowerCase() === wallet;
  const ok = rc.status === "0x1";
  const value = BigInt(tx.value);
  if (ok && value > 0n) {
    if (ownTx) flows.push({ symbol: NATIVE, decimals: 18, token: null, amount: -value, counterparty: tx.to?.toLowerCase() });
    else if (tx.to?.toLowerCase() === wallet) flows.push({ symbol: NATIVE, decimals: 18, token: null, amount: value, counterparty: tx.from.toLowerCase() });
  }
  let swapVenue = null;
  for (const log of ok ? rc.logs : []) {
    const t0 = log.topics[0];
    const addr = log.address.toLowerCase();
    if (SWAP_TOPICS[t0]) swapVenue = SWAP_TOPICS[t0];
    if (t0 === TRANSFER && log.topics.length === 3) {
      const src = topicAddr(log.topics[1]);
      const dst = topicAddr(log.topics[2]);
      if (src !== wallet && dst !== wallet) continue;
      const amount = BigInt(log.data);
      const meta = await token(mcp, addr);
      flows.push({ ...meta, token: addr, amount: dst === wallet ? amount : -amount, counterparty: dst === wallet ? src : dst });
    } else if (t0 === APPROVAL && log.topics.length === 3 && topicAddr(log.topics[1]) === wallet) {
      const meta = await token(mcp, addr);
      approvals.push({ ...meta, token: addr, spender: topicAddr(log.topics[2]), amount: BigInt(log.data) });
    } else if (TOKENS[addr]?.symbol === `W${NATIVE}` && (log.topics[1] ?? "").toLowerCase() === pad(wallet)) {
      // WPROS wrap/unwrap: the native leg is internal, so record it from the event.
      try {
        const ev = decodeEventLog({ abi: WITHDRAW, data: log.data, topics: log.topics });
        if (ev.eventName === "Withdrawal") flows.push({ symbol: NATIVE, decimals: 18, token: null, amount: ev.args.wad, counterparty: addr });
      } catch {
        // not Deposit/Withdrawal
      }
    }
  }
  // Net per asset.
  const net = new Map();
  for (const f of flows) {
    const k = f.token ?? NATIVE;
    const cur = net.get(k) ?? { ...f, amount: 0n };
    cur.amount += f.amount;
    net.set(k, cur);
  }
  const nets = [...net.values()].filter((f) => f.amount !== 0n);
  const gasPaid = ownTx ? BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? tx.gasPrice) : 0n;
  const sent = nets.filter((f) => f.amount < 0n);
  const got = nets.filter((f) => f.amount > 0n);

  let category;
  if (!ownTx) category = got.length ? "transfer in" : "other";
  else if (!ok) category = "failed";
  else if (approvals.length && !nets.length) category = "approval";
  else if (sent.length && got.length) category = "swap";
  else if (sent.length && !got.length && (tx.input === "0x" || isPlainTokenTransfer(tx))) category = "transfer out";
  else if (got.length && !sent.length && tx.input === "0x") category = "transfer in";
  else category = "contract interaction";

  return {
    hash: tx.hash,
    block: Number(BigInt(rc.blockNumber)),
    time: new Date(Number(BigInt(tx.blockTimestamp)) * 1000),
    category,
    ownTx,
    ok,
    to: tx.to?.toLowerCase() ?? null,
    created: rc.contractAddress?.toLowerCase() ?? null,
    selector: tx.input.slice(0, 10),
    nets,
    approvals,
    gasPaid,
    swapVenue,
  };
}

const isPlainTokenTransfer = (tx) => tx.input.startsWith("0xa9059cbb") && TOKENS[tx.to?.toLowerCase()] !== undefined;

// ─────────────────────────── report ───────────────────────────

const CATS = ["transfer in", "transfer out", "swap", "approval", "contract interaction", "failed"];

function totals(rows) {
  const by = Object.fromEntries(CATS.map((c) => [c, { count: 0, assets: new Map() }]));
  for (const r of rows) {
    const c = by[r.category] ?? (by[r.category] = { count: 0, assets: new Map() });
    c.count++;
    for (const f of r.nets) {
      const a = c.assets.get(f.symbol) ?? { decimals: f.decimals, in: 0n, out: 0n };
      if (f.amount > 0n) a.in += f.amount;
      else a.out += -f.amount;
      c.assets.set(f.symbol, a);
    }
  }
  return by;
}

const amt = (v, d, s) => `${human(v < 0n ? -v : v, d, 6)} ${s}`;
const flowText = (r) =>
  r.nets.map((f) => `${f.amount > 0n ? "+" : "−"}${amt(f.amount, f.decimals, f.symbol)}`).join(", ") || "no value moved";

function markdown(rows, meta) {
  const by = totals(rows);
  const own = rows.filter((r) => r.ownTx);
  const gas = own.reduce((s, r) => s + r.gasPaid, 0n);
  const unlimited = rows.flatMap((r) => r.approvals.filter((a) => a.amount === MAX_UINT).map((a) => ({ ...a, r })));
  const failed = rows.filter((r) => r.category === "failed");
  const created = rows.filter((r) => r.created);

  const L = [];
  L.push(`# Wallet activity report`, ``);
  L.push(`**Wallet:** [\`${wallet}\`](${addrLink(wallet)})  `);
  L.push(`**Period:** ${from} to ${to} (UTC)  `);
  L.push(`**Network:** Pharos mainnet (chain 1672)  `);
  L.push(`**Generated:** ${meta.generated} · transactions and receipts read through Pharos Chain MCP (${MCP_URL}), hashes discovered via the Pharos explorer API`, ``);

  L.push(`## Summary`, ``);
  const parts = [];
  parts.push(`In this period the wallet sent **${own.length}** transaction${own.length === 1 ? "" : "s"} of its own` +
    (rows.length - own.length ? ` and was the recipient in **${rows.length - own.length}** transaction${rows.length - own.length === 1 ? "" : "s"} sent by others` : ``) + `.`);
  parts.push(`It paid **${amt(gas, 18, NATIVE)}** in network fees.`);
  const NOUN = { "transfer in": "incoming transfer", "transfer out": "outgoing transfer", swap: "swap", approval: "approval", "contract interaction": "other contract interaction", failed: "failed transaction" };
  const brief = CATS.filter((c) => by[c].count).map((c) => `${by[c].count} ${NOUN[c]}${by[c].count === 1 ? "" : "s"}`);
  if (brief.length) parts.push(`Activity: ${brief.join(", ")}.`);
  if (unlimited.length) parts.push(`⚠️ It granted **${unlimited.length} unlimited approval${unlimited.length === 1 ? "" : "s"}**: the spender can move that token from the wallet without further signatures until the approval is revoked.`);
  if (failed.length) parts.push(`${failed.length} of its transactions failed (fees were still paid).`);
  if (created.length) parts.push(`It deployed ${created.length} contract${created.length === 1 ? "" : "s"}.`);
  if (meta.truncated) parts.push(`⚠️ Only the first ${max} transactions in the period were analysed (\`--max\`).`);
  L.push(parts.join(" "), ``);

  L.push(`## Totals by category`, ``);
  L.push(`| Category | Transactions | In | Out |`, `|---|---:|---|---|`);
  for (const c of CATS) {
    const t = by[c];
    const ins = [...t.assets].filter(([, a]) => a.in).map(([s, a]) => amt(a.in, a.decimals, s)).join("<br>") || "–";
    const outs = [...t.assets].filter(([, a]) => a.out).map(([s, a]) => amt(a.out, a.decimals, s)).join("<br>") || "–";
    L.push(`| ${c} | ${t.count} | ${ins} | ${outs} |`);
  }
  L.push(`| network fees | ${own.length} | – | ${amt(gas, 18, NATIVE)} |`, ``);

  L.push(`## Notable transactions`, ``);
  const notable = [];
  for (const a of unlimited) notable.push([a.r, `Unlimited approval of ${a.symbol} to ${label(a.spender)} ([${short(a.spender)}](${addrLink(a.spender)}))`]);
  for (const r of failed) notable.push([r, `Failed transaction to ${r.to ? label(r.to) : "contract creation"} (fee ${amt(r.gasPaid, 18, NATIVE)} paid)`]);
  for (const r of created) notable.push([r, `Deployed contract [${short(r.created)}](${addrLink(r.created)})`]);
  // Largest single movement in and out per asset.
  const biggest = new Map();
  for (const r of rows) for (const f of r.nets) {
    const k = `${f.symbol}:${f.amount > 0n ? "in" : "out"}`;
    const abs = f.amount < 0n ? -f.amount : f.amount;
    if (!biggest.has(k) || abs > biggest.get(k).abs) biggest.set(k, { r, f, abs });
  }
  for (const [k, { r, f }] of biggest) {
    notable.push([r, `Largest ${k.endsWith("in") ? "inflow" : "outflow"} of ${f.symbol}: ${amt(f.amount, f.decimals, f.symbol)} ${k.endsWith("in") ? "from" : "to"} ${f.counterparty ? label(f.counterparty) : "?"} (${r.category})`]);
  }
  if (!notable.length) L.push(`None.`, ``);
  else {
    L.push(`| When (UTC) | What | Tx |`, `|---|---|---|`);
    for (const [r, what] of notable) L.push(`| ${iso(r.time)} | ${what} | [${short(r.hash)}](${txLink(r.hash)}) |`);
    L.push(``);
  }

  L.push(`## All transactions`, ``);
  L.push(`| When (UTC) | Category | Counterparty / contract | Movement | Fee (${NATIVE}) | Tx |`, `|---|---|---|---|---:|---|`);
  for (const r of rows) {
    const cp = r.created ? `created ${short(r.created)}` : r.to ? label(r.to) : "–";
    const venue = r.swapVenue ? ` (${r.swapVenue})` : "";
    L.push(`| ${iso(r.time)} | ${r.category}${venue} | ${cp} | ${flowText(r)}${r.approvals.length ? ` · approve ${r.approvals.map((a) => `${a.amount === MAX_UINT ? "unlimited" : amt(a.amount, a.decimals, a.symbol)} ${a.amount === MAX_UINT ? a.symbol : ""}`.trim()).join(", ")}` : ""} | ${r.ownTx ? human(r.gasPaid, 18, 6) : "–"} | [${short(r.hash)}](${txLink(r.hash)}) |`);
  }
  L.push(``, `## How this was produced`, ``);
  L.push(`- Transaction hashes in the period: Pharos explorer API (\`/address/{wallet}/transactions\` and \`/token_transfers\`).`);
  L.push(`- Each transaction and receipt: Chain MCP \`get_transaction\` and \`get_transaction_receipt\`. Token symbol/decimals: Chain MCP \`eth_call\`.`);
  L.push(`- Categories come from the receipt logs: ERC-20 \`Transfer\`/\`Approval\` events touching the wallet, native value, and WPROS \`Withdrawal\`. A transaction where the wallet both gave up one asset and received another is a swap.`);
  L.push(`- Not covered: native PROS received through internal calls (other than WPROS unwraps), NFTs (ERC-721 transfers have 4 topics and are skipped).`);
  return L.join("\n") + "\n";
}

const iso = (d) => d.toISOString().replace("T", " ").slice(0, 16);

function csv(rows) {
  const out = [["time_utc", "tx_hash", "category", "own_tx", "status", "to", "asset", "token", "amount", "direction", "counterparty", "fee_pros", "link"]];
  for (const r of rows) {
    const base = [iso(r.time), r.hash, r.category, r.ownTx, r.ok ? "success" : "failed", r.to ?? r.created ?? ""];
    const fee = r.ownTx ? human(r.gasPaid, 18, 18).replace(/,/g, "") : "";
    if (!r.nets.length && !r.approvals.length) out.push([...base, "", "", "", "", "", fee, txLink(r.hash)]);
    r.nets.forEach((f, i) => out.push([...base, f.symbol, f.token ?? "native", human(f.amount < 0n ? -f.amount : f.amount, f.decimals, 18).replace(/,/g, ""), f.amount > 0n ? "in" : "out", f.counterparty ?? "", i === 0 ? fee : "", txLink(r.hash)]));
    for (const a of r.approvals) out.push([...base, a.symbol, a.token, a.amount === MAX_UINT ? "unlimited" : human(a.amount, a.decimals, 18).replace(/,/g, ""), "approve", a.spender, r.nets.length ? "" : fee, txLink(r.hash)]);
  }
  return out.map((row) => row.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
}

// ─────────────────────────── main ───────────────────────────

const hashes = await discover();
const truncated = hashes.length > max;
console.error(`${hashes.length} transactions in range${truncated ? `, analysing the first ${max}` : ""}`);
const mcp = await connect();
const rows = [];
try {
  for (const [i, h] of hashes.slice(0, max).entries()) {
    rows.push(await analyse(mcp, await load(mcp, h)));
    if ((i + 1) % 25 === 0) console.error(`  ${i + 1}/${Math.min(max, hashes.length)}`);
  }
} finally {
  await mcp.close();
}
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `report-${wallet.slice(0, 8)}-${from}-${to}`);
writeFileSync(`${base}.md`, markdown(rows, { generated: new Date().toISOString(), truncated }));
writeFileSync(`${base}.csv`, csv(rows));
console.log(`${base}.md\n${base}.csv`);
