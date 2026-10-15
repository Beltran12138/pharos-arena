import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../trend-watcher/rule.mjs";

const series = (...vals) => vals.map((value, i) => ({ seq: i + 1, value }));
const DOWN = { direction: "down", observations: 4, minStepPct: 0.3, minTotalPct: 1.0 };

test("three consecutive drops of ≥0.3% (4 observations, ≥1% total) trigger", () => {
  const r = evaluate(series(100, 99.6, 99.2, 98.8), DOWN);
  assert.equal(r.met, true);
  assert.equal(r.window[0].seq, 1);
  assert.equal(r.window[1].seq, 4);
});

test("a single spike, however large, does not trigger", () => {
  // the real pattern seen on the WPROS/USDC pool: +18.8% then -15.8% then flat
  assert.equal(evaluate(series(0.5882, 0.6987, 0.5883, 0.5905, 0.5919), DOWN).met, false);
  assert.equal(evaluate(series(100, 80, 100, 100), DOWN).met, false);
});

test("a pause in the middle resets the streak", () => {
  assert.equal(evaluate(series(100, 99.6, 99.2, 99.19, 98.8, 98.4), DOWN).met, false);
});

test("steps below minStepPct don't count, even if the total is large", () => {
  assert.equal(evaluate(series(100, 99.8, 99.6, 99.4, 99.2, 99.0), DOWN).met, false);
});

test("enough steps but too little in total does not trigger", () => {
  assert.equal(evaluate(series(100, 99.7, 99.4, 99.1), { ...DOWN, minTotalPct: 1.0 }).met, false);
});

test("needs at least 3 observations and direction matters", () => {
  assert.throws(() => evaluate(series(1, 2), { ...DOWN, observations: 2 }));
  assert.equal(evaluate(series(100, 99.6, 99.2, 98.8), { ...DOWN, direction: "up" }).met, false);
  assert.equal(evaluate(series(98.8, 99.2, 99.6, 100), { ...DOWN, direction: "up" }).met, true);
});
