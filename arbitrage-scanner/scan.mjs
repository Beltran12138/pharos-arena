#!/usr/bin/env node
// Arbitrage Scanner (Pharos Agent Arena, Hard): every WPROS/USDC pool of the V3 factory plus the Chainlink
// oracle, read at one block; for each pair of pools the most profitable size after fees, price impact, gas and a
// slippage buffer; act (simulated) only above the threshold, otherwise log why not.
//
//   node arbitrage-scanner/scan.mjs [--config config.json] [--every 30] [--for 600]
//
// Execution is simulated: the plan (sizes, minimum outputs) is logged, nothing is signed. The quote is the V3
// exact-input formula, replayed to the wei on real swaps (skill-chain-mcp-flow), and trusted only inside each
// pool's current liquidity range (tickBitmap).
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../lib/mcp.mjs";
import { readFeed } from "../lib/pharos.mjs";
import { poolState, priceOf } from "../lib/v3.mjs";
import { bestArb, decide } from "./arb.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cfg = JSON.parse(readFileSync(opt("--config", join(here, "config.json")), "utf8"));
const stopAt = Date.now() + Number(opt("--for", "0")) * 1000;
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const mcp = await connect();
try {
  for (;;) {
    await scan();
    if (Date.now() >= stopAt) break;
    await new Promise((r) => setTimeout(r, Number(opt("--every", "30")) * 1000));
  }
} finally {
  await mcp.close();
}

async function scan() {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const states = [];
  for (const p of cfg.pools) {
    try {
      states.push({ ...(await poolState(mcp, p.address, block)), label: p.label });
    } catch (e) {
      console.log(`  ${p.label}: unreadable at block ${block} (${e.message.slice(0, 80)}) — left out of this scan`);
    }
  }
  const [pros, usdc] = [await readFeed(mcp, "PROS/USD", block), await readFeed(mcp, "USDC/USD", block)];
  const oracle = pros.price / usdc.price;
  const { gasPriceWei } = await mcp.call("get_gas_price");
  const gasUsd = ((cfg.gasPerSwap * 2 * Number(gasPriceWei)) / 1e18) * pros.price;

  console.log(`\n${stamp()} scan at block ${block}: ${states.length} pools, Chainlink WPROS ≈ ${oracle.toFixed(5)} USDC; gas for 2 swaps ≈ $${gasUsd.toFixed(5)}`);
  for (const s of states) {
    const p = priceOf(s.sqrtPriceX96, cfg.dec0, cfg.dec1);
    console.log(`  ${s.label.padEnd(12)} ${p.toFixed(5)}  (${((p / oracle - 1) * 100).toFixed(3)}% vs oracle)  USDC reserve ${(Number(s.reserve1) / 1e6).toFixed(0)}`);
  }
  const results = [];
  for (let i = 0; i < states.length; i++)
    for (let j = i + 1; j < states.length; j++) {
      const r = bestArb(states[i], states[j], { dec0: cfg.dec0, dec1: cfg.dec1, gasUsd, slippageBps: cfg.slippageBps });
      const d = decide(r, cfg);
      const name = (a) => states.find((s) => s.pool === a).label;
      const line = { at: new Date().toISOString(), block, buyIn: name(r.cheap), sellIn: name(r.dear), spreadBps: r.spreadBps, feeBps: r.feeBps, size: r.size, gross: r.gross, feesUsd: r.feesUsd, impactUsd: r.impactUsd, gasUsd: r.gasUsd, slippageUsd: r.slippageUsd, net: r.net, decision: d.action, why: d.why };
      results.push(line);
      appendFileSync(join(here, "scans.jsonl"), JSON.stringify(line) + "\n");
      console.log(`  ${d.action === "act" ? "ACT " : "skip"} buy in ${line.buyIn}, sell in ${line.sellIn}: spread ${r.spreadBps.toFixed(1)} bps, fees ${r.feeBps.toFixed(1)} bps` +
        (r.net == null ? "" : `; best size $${r.size.toFixed(2)}: gross $${r.gross.toFixed(4)} = ideal $${r.idealUsd.toFixed(4)} − fees $${r.feesUsd.toFixed(4)} − impact $${r.impactUsd.toFixed(4)}; − gas $${r.gasUsd.toFixed(5)} − slippage $${r.slippageUsd.toFixed(4)} → net $${r.net.toFixed(4)}`) +
        ` — ${d.why}`);
      if (d.action === "act")
        console.log(`        simulated plan: swap ${r.size.toFixed(2)} USDC → ${r.token0.toFixed(4)} WPROS in ${short(r.cheap)}, then that WPROS → ≥ ${(Number(r.minOut) / 1e6 * (1 - cfg.slippageBps / 1e4)).toFixed(4)} USDC in ${short(r.dear)} (not signed)`);
    }
  return results;
}
