import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY, bumped, classify, compensationPlan, droppedDecision, fold, gasDecision } from "../saga-executor/policy.mjs";

const gwei = (n) => BigInt(n) * 10n ** 9n;
const DEF = [
  { name: "wrap", forward: true, compensate: "unwrap" },
  { name: "approve", forward: true, compensate: "revoke" },
  { name: "supply", forward: true, compensate: "withdraw" },
];

test("errors: reverts are permanent; network, rate limits and HTML error pages are transient", () => {
  assert.equal(classify(new Error("estimate_gas: execution reverted: market not created")), "permanent");
  assert.equal(classify(new Error("insufficient funds for gas * price + value")), "permanent");
  assert.equal(classify(new Error("HTTP 429 Too Many Requests")), "transient");
  assert.equal(classify(new Error("fetch failed: ECONNRESET")), "transient");
  assert.equal(classify(new Error("MCP error -32001: Request timed out")), "transient");
  assert.equal(classify(new Error("Unexpected token '<', \"<html>…\" is not valid JSON")), "transient");
  // unknown → permanent: never retry blindly something we don't understand
  assert.equal(classify(new Error("something odd")), "permanent");
});

test("gas spike: send at or under the cap, wait above it, pause when it lasts", () => {
  assert.equal(gasDecision(gwei(10), 0).action, "send");
  assert.equal(gasDecision(POLICY.gasCapWei, 0).action, "send");
  assert.equal(gasDecision(gwei(80), 0).action, "wait");
  assert.equal(gasDecision(gwei(80), POLICY.gasWaitMax - 1).action, "wait");
  assert.equal(gasDecision(gwei(80), POLICY.gasWaitMax).action, "pause");
});

test("dropped transaction: wait if pending, rebroadcast, then replace at a higher price, then pause", () => {
  const s = (o) => droppedDecision({ known: false, nonceUsed: false, rebroadcasts: 0, replacements: 0, ...o }).action;
  assert.equal(s({ known: true }), "wait");
  assert.equal(s({}), "rebroadcast");
  assert.equal(s({ rebroadcasts: POLICY.rebroadcasts }), "replace");
  assert.equal(s({ rebroadcasts: POLICY.rebroadcasts, replacements: POLICY.replacements }), "pause");
  // the nonce moved: never re-send, find out what took it
  assert.equal(s({ nonceUsed: true, rebroadcasts: 9, replacements: 9 }), "reconcile");
});

test("replacement price: +25% of the old one, at least the network price, rounded up", () => {
  assert.equal(bumped(gwei(10), gwei(10)), gwei(12.5 * 2) / 2n);
  assert.equal(bumped(gwei(10), gwei(20)), gwei(20));
  assert.equal(bumped(3n, 1n), 4n); // 3.75 → 4, never below +25%
});

test("state log: last state per step and the phase", () => {
  const st = fold([
    { phase: "started" },
    { step: "wrap", state: "pending" },
    { step: "wrap", state: "sent", tx: "0xaa", nonce: 8 },
    { step: "wrap", state: "verified" },
    { step: "approve", state: "signed", tx: "0xbb", nonce: 9 },
  ]);
  assert.deepEqual(st.steps.wrap, { state: "verified", tx: "0xaa", nonce: 8 });
  assert.equal(st.steps.approve.state, "signed");
  assert.equal(st.phase, "started");
  assert.equal(fold([{ step: "supply", state: "failed", detail: "market not created" }, { phase: "compensating" }]).failure.why, "market not created");
});

test("compensation: undo verified forward steps newest first, skip what is already undone or never happened", () => {
  const st = (steps) => ({ steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { state: v }])) });
  // supply failed after wrap and approve: revoke, then unwrap
  assert.deepEqual(compensationPlan(DEF, st({ wrap: "verified", approve: "verified", supply: "failed" })), ["revoke", "unwrap"]);
  // full rollback of a completed saga
  assert.deepEqual(compensationPlan(DEF, st({ wrap: "verified", approve: "verified", supply: "verified" })), ["withdraw", "revoke", "unwrap"]);
  // resumed after the revoke was done: only the unwrap is left
  assert.deepEqual(compensationPlan(DEF, st({ wrap: "verified", approve: "verified", supply: "failed", revoke: "verified" })), ["unwrap"]);
  // a step that was only sent (not verified) is not undone
  assert.deepEqual(compensationPlan(DEF, st({ wrap: "sent" })), []);
});
