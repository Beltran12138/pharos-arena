import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, report, targetFrom } from "../gas-fee-optimizer/policy.mjs";

const G = 1_000_000_000n;

test("holds while gas is above target, submits once it is at or below", () => {
  const base = { now: 0, deadline: 600, marginSec: 20, target: 10n * G };
  assert.equal(decide({ ...base, current: 12n * G }).action, "hold");
  assert.equal(decide({ ...base, current: 10n * G }).action, "submit");
});

test("never misses the deadline: from deadline − margin it submits whatever the price", () => {
  const base = { deadline: 600, marginSec: 20, current: 99n * G, target: 5n * G };
  assert.equal(decide({ ...base, now: 579 }).action, "hold");
  for (const now of [580, 599, 600, 10_000]) assert.equal(decide({ ...base, now }).action, "submit", `now ${now}`);
  assert.match(decide({ ...base, now: 700 }).why, /past the deadline/);
});

test("target is the low end of history, never below the floor", () => {
  const h = [10, 10, 12, 15, 20, 11, 10, 30, 10, 10].map((x) => ({ baseFee: String(BigInt(x) * G) }));
  assert.equal(targetFrom(h, 10n * G), 10n * G);
  assert.equal(targetFrom([12, 14, 16].map((x) => ({ baseFee: String(BigInt(x) * G) })), 10n * G), 12n * G);
  assert.equal(targetFrom([], 10n * G), 10n * G);
});

test("report compares the paid cost with the request-time price and with what others paid", () => {
  const r = report({ gasUsed: 21_000n, paidPrice: 10n * G, requestPrice: 12n * G, othersAvgPrice: 11n * G });
  assert.equal(r.cost, 210_000n * G);
  assert.equal(r.savedVsRequest, 42_000n * G);
  assert.equal(r.savedVsOthers, 21_000n * G);
});
