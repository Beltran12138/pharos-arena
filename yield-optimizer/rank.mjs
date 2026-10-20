// Is moving funds worth it? Net gain over a minimum holding period after exit/entry fees and gas. Pure.

const SECONDS_PER_YEAR = 31_536_000;

/**
 * Supply APY of a Morpho market after adding `amount`: utilization falls, so the yield is diluted. The borrow
 * rate is held at its current value (the adaptive IRM lowers it further as utilization falls, so this is an upper
 * bound on the new supply APY).
 */
export function morphoApyAfter(m, amount) {
  const util = m.borrowed / (m.supplied + amount);
  return m.borrowApy * util * (1 - m.fee / 100);
}

/**
 * venues: normalized sources { id, label, kind, asset, apy, apyBasis, exitFeePct, entryFeePct, exitVerified, liquidity, raw }
 * req: { asset, amount, current: venue id | "wallet", holdDays, minGainUsd, assetUsd, allowUnverifiedExit }
 * gas: { usdPerTx } — one tx to leave the current venue, two (approve + deposit) to enter a new one.
 */
export function rank(venues, req, gas) {
  const current = req.current === "wallet" ? null : venues.find((v) => v.id === req.current);
  if (req.current !== "wallet" && !current) return { decision: "unknown", why: `current venue ${req.current} is not one I can read` };
  const years = req.holdDays / 365;
  const usd = (x) => x * req.assetUsd;

  // Staying where you are, for the same period.
  const stayApy = current ? (current.kind === "morpho" ? current.apy : current.apy) : 0;
  const stay = { apy: stayApy, gainUsd: usd(req.amount * (stayApy / 100) * years) };

  // Leaving the current venue: can the amount come out now, and at what cost?
  const exitBlock = current && current.kind === "morpho" && current.liquidity < req.amount
    ? `only ${current.liquidity.toFixed(2)} ${req.asset} can be withdrawn from ${current.label} right now (utilization), less than ${req.amount}` : null;
  const exitFeeUsd = current?.exitFeePct ? usd((req.amount * current.exitFeePct) / 100) : 0;

  const options = [];
  for (const v of venues) {
    if (v.asset !== req.asset || v.id === req.current) continue;
    const reasons = [];
    if (v.apy == null) reasons.push(`no readable yield (${v.apyBasis})`);
    if (!v.exitVerified && !req.allowUnverifiedExit) reasons.push(`exit not verified: ${v.exitNote ?? "no previewRedeem"}`);
    if (v.kind === "morpho" && v.liquidity < 1 && v.apy > 0) reasons.push(`market has ${v.liquidity.toFixed(2)} ${req.asset} of liquidity: funds supplied there could not be withdrawn`);
    const apy = v.kind === "morpho" ? morphoApyAfter(v.raw, req.amount) : v.apy;
    const gross = apy != null ? usd(req.amount * (apy / 100) * years) : null;
    const costs = {
      exitCurrent: exitFeeUsd,
      entryFee: v.entryFeePct ? usd((req.amount * v.entryFeePct) / 100) : 0,
      exitNewLater: v.exitFeePct ? usd((req.amount * v.exitFeePct) / 100) : 0, // you will leave it again eventually
      gas: gas.usdPerTx * ((current ? 1 : 0) + 2),
    };
    const cost = Object.values(costs).reduce((a, b) => a + b, 0);
    const net = gross != null ? gross - cost - stay.gainUsd : null;
    options.push({ venue: v, apy, apyNote: v.kind === "morpho" && apy < v.apy - 0.005 ? `${v.apy.toFixed(2)}% now, ${apy.toFixed(2)}% after adding ${req.amount}` : null, gross, costs, cost, net, excluded: reasons });
  }
  // Highest net first; on a tie (within a cent) the venue whose exit is verified wins.
  const eligible = options.filter((o) => !o.excluded.length && o.net != null)
    .sort((a, b) => (Math.abs(b.net - a.net) > 0.01 ? b.net - a.net : Number(b.venue.exitVerified) - Number(a.venue.exitVerified)));
  const best = eligible[0];
  let decision, why;
  if (exitBlock) [decision, why] = ["stay", exitBlock];
  else if (!best) [decision, why] = ["stay", "no eligible venue"];
  else if (best.net < req.minGainUsd)
    [decision, why] = ["stay", `best move (${best.venue.label}) gains $${best.net.toFixed(2)} over ${req.holdDays} days after costs, below the $${req.minGainUsd} minimum`];
  else [decision, why] = ["move", `${best.venue.label}: +$${best.net.toFixed(2)} over ${req.holdDays} days after costs ($${best.cost.toFixed(2)}) compared with ${current ? `staying in ${current.label}` : "leaving it in the wallet"}`];
  return { decision, why, stay, current, best, options: [...eligible, ...options.filter((o) => o.excluded.length || o.net == null)] };
}

export const gasUsd = (gasPerTx, gasPriceWei, prosUsd) => (gasPerTx * Number(gasPriceWei) / 1e18) * prosUsd;
export { SECONDS_PER_YEAR };
