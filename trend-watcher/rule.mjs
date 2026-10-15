// Trend rule: pure. A trend is confirmed only by N consecutive observations moving the same way, each by at
// least minStepPct, adding up to at least minTotalPct. A single spike (one big move, then back) never has
// N consecutive same-direction steps, so it cannot trigger.

/**
 * @param obs   [{ seq, value }] in order
 * @param rule  { direction: "down" | "up", observations: N >= 3, minStepPct, minTotalPct }
 * @returns { met, streak, window: [first, last] | null, totalPct, reason }
 */
export function evaluate(obs, rule) {
  const n = rule.observations;
  if (!Number.isInteger(n) || n < 3) throw new Error("rule.observations must be an integer >= 3");
  const sign = rule.direction === "down" ? -1 : 1;
  let streak = 1; // observations in the current run (a run of k steps has k+1 observations)
  for (let i = 1; i < obs.length; i++) {
    const step = ((obs[i].value - obs[i - 1].value) / obs[i - 1].value) * 100;
    streak = sign * step >= rule.minStepPct ? streak + 1 : 1;
    if (streak >= n) {
      const first = obs[i - n + 1], last = obs[i];
      const totalPct = ((last.value - first.value) / first.value) * 100;
      if (sign * totalPct >= rule.minTotalPct) {
        return { met: true, streak, window: [first, last], totalPct, reason: `${n} consecutive ${rule.direction} observations, ${totalPct.toFixed(3)}% in total` };
      }
    }
  }
  const tail = obs.slice(-n);
  const totalPct = tail.length > 1 ? ((tail.at(-1).value - tail[0].value) / tail[0].value) * 100 : 0;
  return { met: false, streak, window: null, totalPct, reason: `current ${rule.direction} streak: ${streak} of ${n} observations` };
}
