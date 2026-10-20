// Two-pool arbitrage for one token pair: buy token0 where it is cheap, sell it where it is dear, sized for the
// largest net profit after both pools' fees, price impact, gas and a slippage buffer. Pure.
import { priceOf, quoteInRange, tickAt } from "../lib/v3.mjs";

/** Exact-input quote that is only trusted inside the pool's current liquidity range (see lib/v3.mjs). */
export function leg(state, side, amountIn) {
  if (amountIn <= 0n) return null;
  const q = quoteInRange(state, side, amountIn);
  const after = tickAt(q.sqrtAfter);
  const inRange = side === "sell0" ? after > state.lowTick : after < state.highTick;
  const reserveOut = side === "sell0" ? state.reserve1 : state.reserve0;
  return inRange && q.amountOut < reserveOut ? q : null;
}

/**
 * a, b: pool states (same token0/token1). cfg: { dec0, dec1, gasUsd, slippageBps }.
 * Returns the best route between the two, with every cost and the net result in USD (token1 = USDC).
 */
export function bestArb(a, b, cfg) {
  const pa = priceOf(a.sqrtPriceX96, cfg.dec0, cfg.dec1), pb = priceOf(b.sqrtPriceX96, cfg.dec0, cfg.dec1);
  const [cheap, dear, pc, pd] = pa <= pb ? [a, b, pa, pb] : [b, a, pb, pa];
  const usd = (raw) => Number(raw) / 10 ** cfg.dec1;
  const profit = (x) => {
    const buy = leg(cheap, "buy0", x); // pay x token1 in the cheap pool, receive token0
    if (!buy) return null;
    const sell = leg(dear, "sell0", buy.amountOut); // sell that token0 in the dear pool
    if (!sell) return null;
    const gross = usd(sell.amountOut) - usd(x);
    return { x, token0: buy.amountOut, out: sell.amountOut, gross, net: gross - cfg.gasUsd - (usd(x) * cfg.slippageBps) / 1e4 };
  };

  // Profit is concave in size inside the range: log grid, then a ternary search around the best point.
  let best = null;
  const lo = 10n ** BigInt(cfg.dec1 - 2), hi = BigInt(Math.max(1, Math.floor(Number(cheap.reserve1) * 0.5)));
  const grid = [];
  for (let i = 0; i <= 80; i++) grid.push(BigInt(Math.floor(Number(lo) * (Number(hi) / Number(lo)) ** (i / 80))));
  let bi = -1;
  grid.forEach((x, i) => {
    const p = profit(x);
    if (p && (!best || p.net > best.net)) [best, bi] = [p, i];
  });
  if (best) {
    let [l, r] = [grid[Math.max(0, bi - 1)], grid[Math.min(grid.length - 1, bi + 1)]];
    for (let k = 0; k < 60 && r - l > 2n; k++) {
      const m1 = l + (r - l) / 3n, m2 = r - (r - l) / 3n;
      const [p1, p2] = [profit(m1), profit(m2)];
      if ((p1?.net ?? -Infinity) < (p2?.net ?? -Infinity)) l = m1;
      else r = m2;
    }
    const p = profit((l + r) / 2n);
    if (p && p.net > best.net) best = p;
  }

  const spreadBps = (pd / pc - 1) * 1e4;
  const feeBps = (cheap.feePpm + dear.feePpm) / 100;
  if (!best) return { cheap: cheap.pool, dear: dear.pool, pc, pd, spreadBps, feeBps, size: 0, net: null, why: "no size stays inside both pools' liquidity ranges" };
  // Cost breakdown at the chosen size: what a fee-free, impact-free trade would make, minus fees, minus impact.
  const sizeUsd = usd(best.x);
  const ideal = sizeUsd * (pd / pc - 1);
  const fees = sizeUsd * (cheap.feePpm / 1e6) + sizeUsd * (pd / pc) * (dear.feePpm / 1e6);
  const impact = ideal - fees - best.gross;
  return {
    cheap: cheap.pool, dear: dear.pool, pc, pd, spreadBps, feeBps,
    size: sizeUsd, token0: Number(best.token0) / 10 ** cfg.dec0, idealUsd: ideal, feesUsd: fees, impactUsd: impact,
    gasUsd: cfg.gasUsd, slippageUsd: (sizeUsd * cfg.slippageBps) / 1e4, gross: best.gross, net: best.net, minOut: best.out,
  };
}

/** Act only above the threshold; otherwise say which cost ate the spread. */
export function decide(r, { minNetUsd }) {
  if (r.net == null) return { action: "skip", why: r.why };
  if (r.spreadBps <= r.feeBps) return { action: "skip", why: `spread ${r.spreadBps.toFixed(1)} bps does not cover the two pools' fees (${r.feeBps.toFixed(1)} bps)` };
  if (r.net >= minNetUsd) return { action: "act", why: `net $${r.net.toFixed(4)} ≥ threshold $${minNetUsd}` };
  const costs = { "price impact": r.impactUsd, fees: r.feesUsd, gas: r.gasUsd, "slippage buffer": r.slippageUsd };
  const top = Object.entries(costs).sort((x, y) => y[1] - x[1])[0];
  return { action: "skip", why: `net $${r.net.toFixed(4)} < threshold $${minNetUsd}; the largest cost is ${top[0]} ($${top[1].toFixed(4)})` };
}
