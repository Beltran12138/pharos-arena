#!/usr/bin/env node
// Skill + Chain MCP flow (Pharos Agent Arena, Medium): one user request in, one decision out.
//
//   node skill-chain-mcp-flow/flow.mjs "sell 500 WPROS for USDC" [--wallet 0x…] [--trace trace.jsonl]
//
// 1. parse the request; 2. Chain MCP: pool slot0/liquidity/fee/reserves, Chainlink PROS/USD and USDC/USD,
// gas price, wallet balances; 3. the Skill's rules (decide.mjs, rules.json) turn that live state into
// TRADE / SPLIT / WAIT with the numbers behind it; 4. for TRADE/SPLIT, the follow-up commands in the
// pharos-skill-engine format (cast), prepared for the user to sign — nothing is signed here.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { erc20Abi, formatUnits, parseAbi, parseUnits } from "viem";
import { connect } from "../lib/mcp.mjs";
import { FEEDS, RPC_URL, read, readAgreed } from "../lib/pharos.mjs";
import { decide, fmt } from "./decide.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const request = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const wallet = opt("--wallet", null);
const tracePath = opt("--trace", null);
const rules = JSON.parse(readFileSync(opt("--rules", new URL("./rules.json", import.meta.url)), "utf8"));

const POOL = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16) view returns (uint256)",
]);
const SCAN_WORDS = 4; // bitmap words scanned in the trade direction (256 tick slots each)
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

// 1. The request.
const m = /^(sell|swap)\s+([\d.]+)\s+(wpros|pros|usdc)\b/i.exec(request ?? "");
if (!m) {
  console.error('usage: flow.mjs "sell <amount> <WPROS|PROS|USDC> [for USDC|WPROS]" [--wallet 0x…]');
  process.exit(2);
}
const tokenIn = m[3].toUpperCase();
const side = tokenIn === "USDC" ? "buy0" : "sell0";
const amountIn = parseUnits(m[2], tokenIn === "USDC" ? 6 : 18);
const t0 = Date.now();
const log = (step, what) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${step.padEnd(9)} ${what}`);
log("request", `"${request}" → ${side === "sell0" ? `sell ${m[2]} ${tokenIn} for USDC` : `sell ${m[2]} USDC for WPROS`}${wallet ? `, wallet ${wallet}` : ""}`);

// 2. Live state through Chain MCP. Every call is traced.
const mcp = await connect();
const trace = [];
const call = mcp.call;
mcp.call = async (tool, a = {}) => {
  const s = Date.now();
  const res = await call(tool, a);
  const entry = { tool, args: a, ms: Date.now() - s, result: summary(res) };
  trace.push(entry);
  log("chain-mcp", `${tool}${a.transaction ? ` to ${a.transaction.to.slice(0, 10)}…` : a.address ? ` ${a.address.slice(0, 10)}…` : ""} → ${entry.result} (${entry.ms} ms)`);
  return res;
};
let state;
try {
  const head = Number((await mcp.call("get_block_number")).blockNumber);
  const blk = await mcp.call("get_block", { block: String(head) });
  const [slot0, liquidity, fee, r0, r1, pros, usdc, gas] = [
    // Price and liquidity decide the outcome: take them only when two reads agree (see readAgreed).
    await readAgreed(mcp, POOL, POOL_ABI, "slot0", [], head),
    await readAgreed(mcp, POOL, POOL_ABI, "liquidity", [], head),
    await read(mcp, POOL, POOL_ABI, "fee", [], head),
    await read(mcp, WPROS, erc20Abi, "balanceOf", [POOL], head),
    await read(mcp, USDC, erc20Abi, "balanceOf", [POOL], head),
    await read(mcp, FEEDS["PROS/USD"], FEED_ABI, "latestRoundData", [], head),
    await read(mcp, FEEDS["USDC/USD"], FEED_ABI, "latestRoundData", [], head),
    await mcp.call("get_gas_price"),
  ];
  const spacing = Number(await read(mcp, POOL, POOL_ABI, "tickSpacing", [], head));
  const boundary = await nextInitializedTick(Number(slot0[1]), spacing, head);
  let balance = null;
  if (wallet) {
    const native = BigInt((await mcp.call("get_balance", { address: wallet })).balanceWei);
    const tokenBal = tokenIn === "PROS" ? native : await read(mcp, tokenIn === "WPROS" ? WPROS : USDC, erc20Abi, "balanceOf", [wallet], head);
    balance = { in: tokenBal, pros: native, native: tokenIn === "PROS" };
  }
  state = {
    block: head,
    now: Number(BigInt(blk.timestamp)),
    dec0: 18,
    dec1: 6,
    pool: {
      sqrtPriceX96: slot0[0], liquidity, feePpm: Number(fee), reserve0: r0, reserve1: r1,
      tick: Number(slot0[1]), boundaryTick: boundary.tick, boundaryKind: boundary.kind,
    },
    // Pool price is USDC per WPROS; the oracle comparable is PROS/USD ÷ USDC/USD.
    oracle: { price: Number(pros[1]) / Number(usdc[1]), updatedAt: Math.min(Number(pros[3]), Number(usdc[3])), prosUsd: Number(pros[1]) / 1e18 },
    gasPriceWei: BigInt(gas.gasPriceWei),
    balance,
  };
} finally {
  await mcp.close();
}

// 3. The Skill's decision on that state.
const d = decide(state, { side, amountIn }, rules);
log("skill", `${String(opt("--rules", "rules.json")).split(/[\\/]/).pop()} → ${d.decision}`);
for (const c of d.checks) console.log(`              ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);

// 4. What the user does next, in pharos-skill-engine (cast) form. Prepared, not signed.
const outSym = side === "sell0" ? "USDC" : "WPROS", outDec = side === "sell0" ? 6 : 18, inDec = side === "sell0" ? 18 : 6;
const lines = [];
if (d.decision === "WAIT") {
  lines.push(`WAIT: ${d.plan.why.join(", ")}. Nothing to sign. Re-run when the failing check clears.`);
} else {
  const p = d.plan;
  lines.push(`${d.decision}: ${p.chunks > 1 ? `${p.chunks} chunks of ` : ""}${fmt(p.amountIn, inDec)} ${tokenIn} → expect ${fmt(p.expectedOut, outDec)} ${outSym}` +
    `${p.chunks > 1 ? " per chunk" : ""}, minimum ${fmt(p.minOut, outDec)} ${outSym} (slippage ${rules.slippagePct}%).`);
  if (p.note) lines.push(`Note: ${p.note}.`);
  lines.push("", "Prepared commands (pharos-skill-engine format, mainnet; sign with your own key):");
  if (tokenIn === "PROS") lines.push(`  cast send ${WPROS} "deposit()" --value ${fmt(p.amountIn * BigInt(p.chunks), 18, 18)}ether --private-key $PRIVATE_KEY --rpc-url ${RPC_URL}   # wrap PROS → WPROS`);
  lines.push(`  cast call ${POOL} "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url ${RPC_URL}   # re-check the price just before signing`);
  lines.push(`  then swap ${formatUnits(p.amountIn, inDec)} ${side === "sell0" ? "WPROS" : "USDC"} in the WPROS/USDC 0.01% pool with amountOutMinimum = ${p.minOut} (raw ${outSym} units)`);
}
console.log("\n" + lines.join("\n"));

if (tracePath) {
  const record = { at: new Date().toISOString(), request, wallet, block: state.block, trace, decision: d.decision, checks: d.checks, plan: d.plan };
  appendFileSync(tracePath, JSON.stringify(record, (k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

/**
 * Nearest initialized tick in the trade direction (down when selling WPROS, up when buying), from the pool's
 * tickBitmap. Liquidity is constant until the price reaches it. If none is found within SCAN_WORDS words,
 * the edge of the scanned range is returned, so a quote is never trusted further than we looked.
 */
async function nextInitializedTick(tick, spacing, block) {
  const word = Math.floor(tick / spacing) >> 8;
  const down = side === "sell0";
  for (let i = 0; i < SCAN_WORDS; i++) {
    const w = down ? word - i : word + i;
    const bits = await read(mcp, POOL, POOL_ABI, "tickBitmap", [w], block);
    for (let k = 0; k < 256; k++) {
      const b = down ? 255 - k : k;
      const t = (w * 256 + b) * spacing;
      if ((down ? t > tick : t <= tick) || !((bits >> BigInt(b)) & 1n)) continue;
      return { tick: t, kind: "next initialized tick" };
    }
  }
  const edge = (down ? (word - SCAN_WORDS + 1) * 256 : (word + SCAN_WORDS) * 256 - 1) * spacing;
  return { tick: edge, kind: `no initialized tick in the ${SCAN_WORDS * 256} slots scanned` };
}

function summary(res) {
  if (res?.blockNumber && !res.timestamp) return `block ${Number(res.blockNumber)}`;
  if (res?.gasPriceWei) return `${res.gasPriceWei} wei`;
  if (res?.balanceWei) return `${res.balanceWei} wei`;
  if (res?.timestamp && res?.number) return `block ${Number(BigInt(res.number))} @ ${new Date(Number(BigInt(res.timestamp)) * 1000).toISOString()}`;
  const hex = typeof res === "string" ? res : res?.result ?? res?.data;
  if (typeof hex === "string") return `${hex.slice(0, 18)}… (${(hex.length - 2) / 2} bytes)`;
  return JSON.stringify(res).slice(0, 60);
}
