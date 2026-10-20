// Morpho Blue position math (health factor with accrued interest, repair actions). Pure: chain reads are in
// watchdog.mjs. Formulas follow Morpho Blue's own (SharesMathLib, MathLib.wTaylorCompounded, _isHealthy).
import { parseAbi } from "viem";

export const MORPHO_ABI = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
export const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
export const IRM_ABI = parseAbi([
  "function borrowRateView((address,address,address,address,uint256), (uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);

const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
const mulDivUp = (x, y, d) => (x * y + d - 1n) / d;

/** e^(x·n) - 1 by a third-order Taylor expansion, as Morpho Blue compounds interest. */
export function wTaylorCompounded(x, n) {
  const first = x * n;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

/** Total borrow assets after accruing interest from lastUpdate to `now` at `ratePerSec` (WAD). */
export function accruedTotalBorrow(totalBorrowAssets, lastUpdate, now, ratePerSec) {
  const elapsed = BigInt(Math.max(0, now - Number(lastUpdate)));
  if (elapsed === 0n || ratePerSec === 0n) return totalBorrowAssets;
  return totalBorrowAssets + (totalBorrowAssets * wTaylorCompounded(ratePerSec, elapsed)) / WAD;
}

/**
 * Health of one position. Morpho Blue: healthy while collateral·price/1e36·lltv ≥ borrowed, so
 * HF = maxBorrow / borrowed, liquidatable below 1. All amounts in raw token units.
 */
export function health({ borrowShares, collateral, totalBorrowAssets, totalBorrowShares, price, lltv }) {
  const borrowed = mulDivUp(borrowShares, totalBorrowAssets + VIRTUAL_ASSETS, totalBorrowShares + VIRTUAL_SHARES);
  const collateralValue = (collateral * price) / ORACLE_SCALE; // in loan-token units
  const maxBorrow = (collateralValue * lltv) / WAD;
  const hf = borrowed === 0n ? Infinity : Number(maxBorrow) / Number(borrowed);
  return { borrowed, collateralValue, maxBorrow, hf };
}

/**
 * Two ways back to `target`: repay loan tokens, or add collateral. Also how far the collateral price can fall
 * before liquidation. Raw units of the loan and collateral tokens.
 */
export function repairs(h, { collateral, price, lltv, target }) {
  if (h.borrowed === 0n) return null;
  const t = BigInt(Math.round(target * 1e6));
  const allowed = (h.maxBorrow * 1_000_000n) / t; // the debt at which HF = target
  const repay = h.borrowed > allowed ? h.borrowed - allowed : 0n;
  // collateral needed: borrowed·target / (price·lltv), minus what is there
  const needValue = (h.borrowed * t * WAD) / (1_000_000n * lltv); // collateral value in loan units
  const needColl = (needValue * ORACLE_SCALE + price - 1n) / price;
  const add = needColl > collateral ? needColl - collateral : 0n;
  const dropToLiquidationPct = h.hf === Infinity ? null : (1 - 1 / h.hf) * 100;
  return { repay, addCollateral: add, dropToLiquidationPct };
}

/** "ok" | "warn" | "critical" | "liquidatable". */
export function level(hf, { warn, critical }) {
  if (hf < 1) return "liquidatable";
  if (hf < critical) return "critical";
  if (hf < warn) return "warn";
  return "ok";
}

const RANK = { ok: 0, warn: 1, critical: 2, liquidatable: 3 };

/**
 * Whether to alert now. Alerts on any change of level (worse or recovered), and repeats a critical or
 * liquidatable alert at most every `repeatSec`, so a position stuck near the line is not silent but not spammy.
 */
export function shouldAlert(prev, lvl, now, repeatSec) {
  if (!prev) return lvl !== "ok" ? "new" : null;
  if (prev.level !== lvl) return RANK[lvl] > RANK[prev.level] ? "worse" : "better";
  if (RANK[lvl] >= 2 && now - prev.alertedAt >= repeatSec) return "reminder";
  return null;
}
