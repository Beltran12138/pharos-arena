import { test } from "node:test";
import assert from "node:assert/strict";
import { bestArb, decide, leg } from "../arbitrage-scanner/arb.mjs";
import { priceOf } from "../lib/v3.mjs";

// Pools shaped like the real WPROS/USDC 0.01% pool (L ≈ 8e17), at a chosen USDC-per-WPROS price.
const sqrtFor = (p) => BigInt(Math.round(Math.sqrt(p * 1e-12) * 2 ** 96));
const pool = (p, feePpm, label) => ({ pool: label, sqrtPriceX96: sqrtFor(p), liquidity: 801386629611202861n, feePpm, lowTick: -300000, highTick: -260000, reserve0: 10n ** 24n, reserve1: 10n ** 12n });
const cfg = { dec0: 18, dec1: 6, gasUsd: 0.002, slippageBps: 10 };

test("a 1% gap between two deep pools is acted on, at the size where marginal prices meet after fees", () => {
  const a = pool(0.62, 100, "A"), b = pool(0.6262, 500, "B");
  const r = bestArb(a, b, cfg);
  assert.equal(r.cheap, "A");
  assert.ok(r.net > 0.5, `net ${r.net}`);
  assert.equal(decide(r, { minNetUsd: 0.5 }).action, "act");
  // Independent check of the optimum: after both legs, buying in A once more costs what selling in B pays.
  const x = BigInt(Math.round(r.size * 1e6));
  const buy = leg(a, "buy0", x), sell = leg(b, "sell0", buy.amountOut);
  const pa = priceOf(buy.sqrtAfter, 18, 6) / (1 - 100 / 1e6);
  const pb = priceOf(sell.sqrtAfter, 18, 6) * (1 - 500 / 1e6);
  assert.ok(Math.abs(pa / pb - 1) < 0.0015, `marginal prices ${pa} vs ${pb}`); // the 10 bps slippage buffer shifts it slightly
  // and a smaller or larger size makes less
  const net = (k) => { const s = leg(b, "sell0", leg(a, "buy0", (x * k) / 10n).amountOut); return Number(s.amountOut) / 1e6 - (Number(x * k) / 1e7) * (1 + 10 / 1e4); };
  assert.ok(net(10n) > net(8n) && net(10n) > net(12n));
});

test("a gap smaller than the two fees is skipped with that reason", () => {
  const r = bestArb(pool(0.62, 3000, "A"), pool(0.6215, 3000, "B"), cfg);
  const d = decide(r, { minNetUsd: 0.5 });
  assert.equal(d.action, "skip");
  assert.match(d.why, /does not cover the two pools' fees/);
});

test("a wide gap in a pool with almost no in-range liquidity is skipped: the price is not tradable depth", () => {
  const thin = { ...pool(0.6262, 500, "thin"), liquidity: 1321998274356n }; // like the real 0.05% pool
  const r = bestArb(pool(0.62, 100, "deep"), thin, cfg);
  const d = decide(r, { minNetUsd: 0.5 });
  assert.equal(d.action, "skip");
  assert.ok(r.net < 0.01, `net ${r.net}`);
});

test("a quote that leaves the liquidity range is not trusted", () => {
  const p = { ...pool(0.62, 100, "A"), lowTick: -281200 }; // price 0.62 is tick ≈ −281,107; edge 93 ticks below
  assert.ok(leg(p, "sell0", 10n ** 18n)); // 1 WPROS: stays in range
  assert.equal(leg(p, "sell0", 100_000n * 10n ** 18n), null); // 100k WPROS: crosses the edge
});
