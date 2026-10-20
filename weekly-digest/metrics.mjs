// Period metrics and notable events for a Uniswap V3-style pool, from decoded Swap/Mint/Burn logs.
// Pure functions: no chain access, so the numbers can be tested.

const Q96 = 2 ** 96;

/** token1 per token0, decimals applied. */
export const priceOf = (sqrtPriceX96, dec0, dec1) => (Number(sqrtPriceX96) / Q96) ** 2 * 10 ** (dec0 - dec1);

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * events: [{ kind: "swap"|"mint"|"burn", block, time (unix s), tx, amount0, amount1 (bigint, pool's view),
 *            sqrtPriceX96 (swap only), recipient (swap) }], sorted by block/log.
 * meta: { dec0, dec1, sym0, sym1, quoteIsToken1: true }  — USD values use the token1 (USDC) leg.
 */
export function summarize(events, meta) {
  const usd = (raw1) => Math.abs(Number(raw1)) / 10 ** meta.dec1;
  const base = (raw0) => Number(raw0) / 10 ** meta.dec0;
  const swaps = events.filter((e) => e.kind === "swap");
  const mints = events.filter((e) => e.kind === "mint");
  const burns = events.filter((e) => e.kind === "burn");
  const prices = swaps.map((e) => priceOf(e.sqrtPriceX96, meta.dec0, meta.dec1));

  // Pool's view: amount0 > 0 means the pool received token0, i.e. the trader sold token0.
  const sold0 = swaps.reduce((s, e) => s + (e.amount0 > 0n ? base(e.amount0) : 0), 0);
  const bought0 = swaps.reduce((s, e) => s + (e.amount0 < 0n ? -base(e.amount0) : 0), 0);

  return {
    swaps: swaps.length,
    volumeUsd: swaps.reduce((s, e) => s + usd(e.amount1), 0),
    traders: new Set(swaps.map((e) => e.recipient)).size,
    medianSwapUsd: median(swaps.map((e) => usd(e.amount1))),
    netBought0: bought0 - sold0,
    price: prices.length
      ? { open: prices[0], close: prices.at(-1), high: Math.max(...prices), low: Math.min(...prices) }
      : null,
    liquidityAddedUsd: mints.reduce((s, e) => s + liquidityUsd(e, prices, meta), 0),
    liquidityRemovedUsd: burns.reduce((s, e) => s + liquidityUsd(e, prices, meta), 0),
    mints: mints.length,
    burns: burns.length,
  };
}

/** USD value of a Mint/Burn: token1 amount plus token0 amount at the period's close price. */
function liquidityUsd(e, prices, meta) {
  const p = prices.at(-1) ?? 0;
  return Number(e.amount1) / 10 ** meta.dec1 + (Number(e.amount0) / 10 ** meta.dec0) * p;
}

/**
 * Candidate notable events, each scored by how unusual it is for this period (multiple of the period's own
 * median), then the top `n`. Kinds: single swap, liquidity add/remove, one-hour price move, busiest day.
 */
export function notable(events, meta, n = 3) {
  const swaps = events.filter((e) => e.kind === "swap");
  if (!swaps.length) return [];
  const usd = (e) => Math.abs(Number(e.amount1)) / 10 ** meta.dec1;
  const prices = swaps.map((e) => priceOf(e.sqrtPriceX96, meta.dec0, meta.dec1));
  const out = [];

  const medSwap = median(swaps.map(usd)) || 1;
  const bySize = [...swaps].sort((a, b) => usd(b) - usd(a)).slice(0, 3);
  for (const e of bySize) {
    const side = e.amount0 > 0n ? `sold ${meta.sym0}` : `bought ${meta.sym0}`;
    out.push({ score: usd(e) / medSwap, kind: "swap", time: e.time, tx: e.tx,
      text: `Largest swaps: $${fmt(usd(e))} (${side}), ${fmt(usd(e) / medSwap)}× the median swap of $${fmt(medSwap)}` });
  }

  const liq = events.filter((e) => e.kind !== "swap");
  const close = prices.at(-1);
  const liqUsd = (e) => Number(e.amount1) / 10 ** meta.dec1 + (Number(e.amount0) / 10 ** meta.dec0) * close;
  const medLiq = median(liq.map(liqUsd)) || 1;
  for (const e of [...liq].sort((a, b) => liqUsd(b) - liqUsd(a)).slice(0, 2)) {
    out.push({ score: liqUsd(e) / medLiq, kind: e.kind, time: e.time, tx: e.tx,
      text: `Liquidity ${e.kind === "mint" ? "added" : "removed"}: $${fmt(liqUsd(e))}, ${fmt(liqUsd(e) / medLiq)}× the median liquidity change` });
  }

  // Hourly closes → largest one-hour move vs the median one-hour move.
  const hourly = new Map();
  swaps.forEach((e, i) => hourly.set(Math.floor(e.time / 3600), { p: prices[i], e }));
  const hours = [...hourly.entries()].sort((a, b) => a[0] - b[0]);
  const moves = [];
  for (let i = 1; i < hours.length; i++) moves.push({ pct: (hours[i][1].p / hours[i - 1][1].p - 1) * 100, at: hours[i] });
  const medMove = Math.max(median(moves.map((m) => Math.abs(m.pct))), 0.01); // floor: a flat market must not make every move "infinitely" notable
  const big = moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
  if (big) {
    out.push({ score: Math.abs(big.pct) / medMove, kind: "price", time: big.at[0] * 3600, tx: big.at[1].e.tx,
      text: `Sharpest hour: ${meta.sym0} ${big.pct > 0 ? "+" : ""}${big.pct.toFixed(2)}% (to ${big.at[1].p.toFixed(4)} ${meta.sym1}), ${fmt(Math.abs(big.pct) / medMove)}× the median hourly move` });
  }

  // Busiest UTC day by volume vs the median day.
  const days = new Map();
  for (const e of swaps) {
    const d = new Date(e.time * 1000).toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0) + usd(e));
  }
  const medDay = median([...days.values()]) || 1;
  const [bd, bv] = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  if (days.size > 1) out.push({ score: bv / medDay, kind: "day", time: Date.parse(bd) / 1000,
    text: `Busiest day: ${bd}, $${fmt(bv)} volume, ${fmt(bv / medDay)}× the median day` });

  // Prefer three different things: at most one swap, unless there are too few other candidates.
  const sorted = out.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of sorted) if (picked.length < n && !(c.kind === "swap" && picked.some((p) => p.kind === "swap"))) picked.push(c);
  for (const c of sorted) if (picked.length < n && !picked.includes(c)) picked.push(c);
  picked.sort((a, b) => b.score - a.score);
  let rank = 0;
  return picked.map((p) => ({ ...p, text: p.kind === "swap" ? p.text.replace("Largest swaps", ++rank === 1 ? "Largest swap" : "Large swap") : p.text }));
}

/** Percent change, or null when there is no base. */
export const change = (now, prev) => (prev ? ((now - prev) / Math.abs(prev)) * 100 : null);

export function fmt(x) {
  const a = Math.abs(x);
  const dp = a >= 100 ? 0 : a >= 1 ? 1 : 4;
  return x.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

/** Start of the last period [anchor + k·len, anchor + (k+1)·len) that has fully ended at `now` (unix s). */
export const lastCompleteStart = (now, anchor, len) => anchor + (Math.floor((now - anchor) / len) - 1) * len;
