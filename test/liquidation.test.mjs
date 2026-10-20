import { test } from "node:test";
import assert from "node:assert/strict";
import { accruedTotalBorrow, health, level, repairs, shouldAlert, wTaylorCompounded } from "../liquidation-watchdog/morpho.mjs";

const WAD = 10n ** 18n;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);

test("interest: Taylor compounding of 5% APR over a year ≈ e^0.05 − 1", () => {
  const perSec = (5n * WAD) / 100n / 31_536_000n;
  close(Number(wTaylorCompounded(perSec, 31_536_000n)) / 1e18, Math.exp(0.05) - 1, 1e-5);
  // 1,000,000 USDC borrowed, one day at 5%: ≈ 136.99 USDC of interest
  const after = accruedTotalBorrow(1_000_000n * 10n ** 6n, 0, 86_400, perSec);
  close(Number(after - 1_000_000n * 10n ** 6n) / 1e6, 1_000_000 * (Math.exp(0.05 / 365) - 1), 0.01);
});

// Hand example: 1,000 COLL (18 dec) worth 0.9 USDC each, LLTV 86%, debt 700 USDC.
// maxBorrow = 900 × 0.86 = 774 USDC → HF 774 / 700 = 1.105714…
const price = (9n * 10n ** 35n) / 10n ** 12n; // 0.9 · 1e36 · 10^(6−18)
const lltv = (86n * WAD) / 100n;
const pos = { borrowShares: 700n * 10n ** 12n, collateral: 1_000n * WAD, totalBorrowAssets: 700n * 10n ** 6n, totalBorrowShares: 700n * 10n ** 12n, price, lltv };

test("health factor follows Morpho's isHealthy: collateral·price·LLTV / debt", () => {
  const h = health(pos);
  assert.equal(h.borrowed, 700n * 10n ** 6n);
  assert.equal(h.maxBorrow, 774n * 10n ** 6n);
  close(h.hf, 774 / 700, 1e-9);
  assert.equal(health({ ...pos, borrowShares: 0n }).hf, Infinity);
});

test("repairs: repay to the target, or add collateral, and the price drop to liquidation", () => {
  const h = health(pos);
  const r = repairs(h, { collateral: pos.collateral, price, lltv, target: 1.5 });
  assert.equal(r.repay, 184n * 10n ** 6n); // 700 − 774/1.5
  close(Number(r.addCollateral) / 1e18, (700 * 1.5) / (0.9 * 0.86) - 1000, 1e-6); // 356.589…
  close(r.dropToLiquidationPct, (1 - 700 / 774) * 100, 1e-9); // 9.56%
  // Applying the suggested repay really gives HF = target
  const after = health({ ...pos, totalBorrowAssets: 516n * 10n ** 6n, borrowShares: 516n * 10n ** 12n, totalBorrowShares: 516n * 10n ** 12n });
  close(after.hf, 1.5, 1e-9);
});

test("levels and thresholds", () => {
  const th = { warn: 1.3, critical: 1.1 };
  // Thresholds are strict: exactly 1.3 is ok, exactly 1.1 is warn, exactly 1.0 is still not liquidatable.
  assert.deepEqual([1.5, 1.3, 1.29, 1.1, 1.0999, 1, 0.99].map((h) => level(h, th)), ["ok", "ok", "warn", "warn", "critical", "critical", "liquidatable"]);
});

test("alerts: on each level change and as a spaced reminder while critical, never repeated otherwise", () => {
  const H = 3600;
  assert.equal(shouldAlert(undefined, "ok", 0, 6 * H), null);
  assert.equal(shouldAlert(undefined, "warn", 0, 6 * H), "new");
  const warn = { level: "warn", alertedAt: 0 };
  assert.equal(shouldAlert(warn, "warn", 10 * H, 6 * H), null); // warn does not repeat
  assert.equal(shouldAlert(warn, "critical", 1, 6 * H), "worse");
  const crit = { level: "critical", alertedAt: 0 };
  assert.equal(shouldAlert(crit, "critical", 5 * H, 6 * H), null);
  assert.equal(shouldAlert(crit, "critical", 6 * H, 6 * H), "reminder");
  assert.equal(shouldAlert(crit, "ok", 1, 6 * H), "better");
});
