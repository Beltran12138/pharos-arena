import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, quoteInRange, tickAt } from "../skill-chain-mcp-flow/decide.mjs";

// Real consecutive swaps of the WPROS/USDC pool (Swap events, 2026-10-20): state after one swap and the
// amounts of the next. The quote must reproduce the chain's own numbers.
const L = 801386629611202861n;
const FEE = 100;

test("quote matches real swaps to the wei (sell and buy)", () => {
  const sell = quoteInRange({ sqrtPriceX96: 62621392537197329924968n, liquidity: L, feePpm: FEE }, "sell0", 62519349288526028800n);
  assert.equal(sell.amountOut, 39050852n);
  assert.equal(sell.sqrtAfter, 62617531819845232968822n);
  const buy = quoteInRange({ sqrtPriceX96: 62578941523859092065388n, liquidity: L, feePpm: FEE }, "buy0", 312161346n);
  assert.equal(buy.amountOut, 500062549090159230455n);
});

test("tickAt agrees with the pool's reported tick", () => {
  assert.equal(tickAt(62617531819845232968822n), -281030);
  assert.equal(tickAt(62578941523859092065388n), -281043);
});

const rules = { maxOracleAgeSec: 3900, maxDeviationPct: 0.5, maxImpactPct: 0.3, slippagePct: 0.5, gasReservePros: 0.01, maxChunks: 20 };
const W = 10n ** 18n;
const base = (over = {}) => ({
  now: 10_000,
  dec0: 18,
  dec1: 6,
  pool: { sqrtPriceX96: 62617531819845232968822n, liquidity: L, feePpm: FEE, reserve0: 434_000n * W, reserve1: 540_000n * 10n ** 6n,
    tick: -281030, boundaryTick: -282054, boundaryKind: "test" },
  oracle: { price: 0.6247, updatedAt: 9_000 },
  gasPriceWei: 10_000_000_000n,
  balance: null,
  ...over,
});

test("small sale: TRADE with minOut = expected less slippage", () => {
  const d = decide(base(), { side: "sell0", amountIn: 3n * W }, rules);
  assert.equal(d.decision, "TRADE");
  assert.equal(d.plan.minOut, (d.plan.expectedOut * 995_000n) / 1_000_000n);
});

test("large sale: SPLIT into the fewest chunks that each stay under the impact limit", () => {
  const d = decide(base(), { side: "sell0", amountIn: 20_000n * W }, rules);
  assert.equal(d.decision, "SPLIT");
  assert.ok(d.plan.impactPct <= 0.3);
  const fewer = decide(base(), { side: "sell0", amountIn: (20_000n * W) / BigInt(d.plan.chunks - 1) }, rules);
  assert.ok(fewer.impactPct > 0.3, "one chunk fewer would exceed the limit");
});

test("pool worse than the oracle for this side → WAIT; the same gap in your favour does not block", () => {
  const poolBelow = base({ oracle: { price: 0.6300, updatedAt: 9_000 } }); // pool ≈0.6237, 1% under
  assert.equal(decide(poolBelow, { side: "sell0", amountIn: 3n * W }, rules).decision, "WAIT");
  const buying = { ...poolBelow, pool: { ...poolBelow.pool, boundaryTick: -280006 } }; // buys move the price up
  assert.equal(decide(buying, { side: "buy0", amountIn: 2n * 10n ** 6n }, rules).decision, "TRADE");
});

test("stale oracle → WAIT", () => {
  const d = decide(base({ oracle: { price: 0.6247, updatedAt: 10_000 - 4_000 } }), { side: "sell0", amountIn: 3n * W }, rules);
  assert.equal(d.decision, "WAIT");
  assert.deepEqual(d.plan.why, ["oracle fresh"]);
});

test("selling native PROS: what is left after the sale must cover gas", () => {
  const bal = (pros) => ({ balance: { in: pros, pros, native: true } });
  assert.equal(decide(base(bal(5n * W)), { side: "sell0", amountIn: 3n * W }, rules).decision, "TRADE");
  assert.equal(decide(base(bal(3n * W)), { side: "sell0", amountIn: 3n * W }, rules).decision, "WAIT"); // nothing left for gas
});

test("a quote that crosses the next initialized tick is not trusted, even if impact looks fine", () => {
  const near = base({ pool: { ...base().pool, boundaryTick: -281035 } }); // 5 ticks below
  const d = decide(near, { side: "sell0", amountIn: 3_000n * W }, rules);
  assert.equal(d.checks.find((c) => c.name === "liquidity range").ok, false);
  assert.notEqual(d.decision, "TRADE");
});
