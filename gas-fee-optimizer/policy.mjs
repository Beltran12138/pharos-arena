// When to submit a held transaction. Pure, so the deadline guarantee can be tested.

/**
 * now, deadline: unix seconds. marginSec: submit no later than deadline − margin, so the transaction is
 * mined by the deadline. current: gas price now (wei, bigint). target: the price we wait for (wei).
 * Returns { action: "submit" | "hold", why }.
 */
export function decide({ now, deadline, marginSec, current, target }) {
  const lastCall = deadline - marginSec;
  if (now >= lastCall) return { action: "submit", why: now >= deadline ? "past the deadline: submitting immediately" : `deadline in ${deadline - now}s: submitting now, whatever the price` };
  if (current <= target) return { action: "submit", why: `gas ${gwei(current)} ≤ target ${gwei(target)}` };
  return { action: "hold", why: `gas ${gwei(current)} > target ${gwei(target)}; holding (latest submit in ${lastCall - now}s)` };
}

/** Target: the low end of recent history (p10 of sampled base fees), never below the current floor. */
export function targetFrom(history, floor) {
  const xs = history.map((h) => BigInt(h.baseFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!xs.length) return floor;
  const p10 = xs[Math.floor(xs.length * 0.1)];
  return p10 > floor ? p10 : floor;
}

/** What the transaction cost against the price at request time and against what others paid meanwhile. */
export function report({ gasUsed, paidPrice, requestPrice, othersAvgPrice }) {
  const cost = gasUsed * paidPrice;
  const atRequest = gasUsed * requestPrice;
  const atOthers = othersAvgPrice ? (gasUsed * othersAvgPrice) : null;
  return { cost, atRequest, savedVsRequest: atRequest - cost, atOthers, savedVsOthers: atOthers != null ? atOthers - cost : null };
}

export const gwei = (wei) => `${(Number(wei) / 1e9).toFixed(Number(wei) % 1e9 === 0 ? 0 : 3)} gwei`;
