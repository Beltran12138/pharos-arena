import { test } from "node:test";
import assert from "node:assert/strict";
import { morphoApyAfter, rank } from "../yield-optimizer/rank.mjs";

const mk = (id, apy, o = {}) => ({ id, label: id, kind: "vault", asset: "USDC", apy, entryFeePct: 0, exitFeePct: 0, exitVerified: true, ...o });
const morpho = (id, supplied, borrowed, borrowApy, o = {}) => {
  const raw = { supplied, borrowed, borrowApy, fee: 0 };
  return { id, label: id, kind: "morpho", asset: "USDC", apy: morphoApyAfter(raw, 0), entryFeePct: 0, exitFeePct: 0, exitVerified: true, liquidity: supplied - borrowed, raw, ...o };
};
const gas = { usdPerTx: 0.001 };
const req = (o) => ({ asset: "USDC", amount: 10_000, current: "wallet", holdDays: 30, minGainUsd: 5, assetUsd: 1, ...o });

test("move when the gain over the holding period beats staying by more than the minimum, after fees and gas", () => {
  const r = rank([mk("A", 10), mk("B", 6)], req({ current: "B" }), gas);
  assert.equal(r.decision, "move");
  assert.equal(r.best.venue.id, "A");
  // (10% − 6%) × 10,000 × 30/365 = 32.88, minus 3 txs of gas
  assert.ok(Math.abs(r.best.net - (10_000 * 0.04 * 30) / 365 + 0.003) < 1e-6);
});

test("stay put when the gain is below the minimum, and say why", () => {
  const r = rank([mk("A", 10), mk("B", 6)], req({ current: "B", holdDays: 3 }), gas);
  assert.equal(r.decision, "stay");
  assert.match(r.why, /below the \$5 minimum/);
});

test("an exit fee on the new venue counts against it", () => {
  const r = rank([mk("A", 10, { exitFeePct: 1 }), mk("B", 9)], req({}), gas);
  assert.equal(r.best.venue.id, "B"); // A: 82.19 − 100 fee < B: 73.97
});

test("vaults with unverified exits are excluded unless the user accepts them; ties prefer the verified exit", () => {
  const venues = [mk("async", 13.5, { exitVerified: false, exitNote: "ERC-7540 requests" }), mk("sync", 13.5)];
  assert.equal(rank(venues, req({}), gas).best.venue.id, "sync");
  assert.ok(rank(venues, req({}), gas).options.find((o) => o.venue.id === "async").excluded[0].includes("ERC-7540"));
  assert.equal(rank(venues, req({ allowUnverifiedExit: true }), gas).best.venue.id, "sync"); // same yield: verified wins
});

test("a deposit dilutes a Morpho market's supply APY; a market without liquidity cannot be left", () => {
  const m = morpho("M", 1_000_000, 900_000, 6); // 90% utilized, 5.4%
  assert.ok(Math.abs(m.apy - 5.4) < 1e-9);
  assert.ok(Math.abs(morphoApyAfter(m.raw, 1_000_000) - 2.7) < 1e-9); // utilization halves
  const r = rank([m, mk("A", 12)], req({ current: "M", amount: 200_000 }), gas);
  assert.equal(r.decision, "stay");
  assert.match(r.why, /only 100000\.00 USDC can be withdrawn/);
});

test("dust is not worth the gas", () => {
  const r = rank([mk("A", 5)], { asset: "USDC", amount: 0.01, current: "wallet", holdDays: 30, minGainUsd: 0.01, assetUsd: 1 }, gas);
  assert.equal(r.decision, "stay");
});
