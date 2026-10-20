import { test } from "node:test";
import assert from "node:assert/strict";
import { dueTimes, fold, instanceId, matchPayment, nextDue, usedTxs } from "../recurring-payment/schedule.mjs";

const ts = (d) => Date.parse(d) / 1000;
const days = (s, now) => dueTimes(s, ts(now)).map((t) => new Date(t * 1000).toISOString().slice(0, 10));

test("weekly and monthly calendars, including month-end clamping", () => {
  assert.deepEqual(days({ every: "weekly", start: "2026-10-06" }, "2026-10-20T00:00:00Z"), ["2026-10-06", "2026-10-13", "2026-10-20"]);
  assert.deepEqual(days({ every: "monthly", start: "2026-01-31" }, "2026-04-30T00:00:00Z"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.equal(new Date(nextDue({ every: "monthly", start: "2026-10-01" }, ts("2026-10-20T00:00:00Z")) * 1000).toISOString().slice(0, 10), "2026-11-01");
  assert.deepEqual(days({ every: "weekly", start: "2026-10-27" }, "2026-10-20T00:00:00Z"), []);
});

test("ledger folding: failed is retried, prepared is pending, stale reopens, paid is final", () => {
  const i = "rent@2026-10-20";
  const st = (evs) => fold(evs.map((e) => ({ instance: i, ...e })))[i];
  assert.equal(st([{ event: "failed", reason: "balance" }]).status, "failed");
  assert.deepEqual([st([{ event: "failed" }, { event: "prepared", nonce: 3, file: "f" }]).status, st([{ event: "failed" }, { event: "prepared", nonce: 3 }]).attempts], ["pending", 2]);
  assert.equal(st([{ event: "prepared", nonce: 3 }, { event: "stale", nonce: 3 }]).status, "due");
  assert.equal(st([{ event: "prepared", nonce: 3 }, { event: "paid", tx: "0xa" }]).status, "paid");
});

test("a used nonce without a visible payment is 'unconfirmed' and keeps its preparation; only a release reopens it", () => {
  // The case found on 2026-10-20: rent was paid, the lookup missed it, and the old code re-prepared it.
  const i = "rent@2026-10-20";
  const st = (evs) => fold(evs.map((e) => ({ instance: i, ...e })))[i];
  const u = st([{ event: "prepared", nonce: 2, file: "f" }, { event: "unconfirmed", nonce: 2 }]);
  assert.deepEqual([u.status, u.prepared.nonce], ["unconfirmed", 2]);
  assert.equal(st([{ event: "prepared", nonce: 2 }, { event: "unconfirmed", nonce: 2 }, { event: "paid", tx: "0xa" }]).status, "paid");
  assert.equal(st([{ event: "prepared", nonce: 2 }, { event: "unconfirmed", nonce: 2 }, { event: "stale", reason: "released by the payer" }]).status, "due");
});

test("matching a payment: exact token/recipient/amount after the due time, and one transfer pays one instance", () => {
  const t = (o) => ({ token: "WPROS", to: "0xbb", value: 100n, time: 1000, tx: "0x1", logIndex: 0, ...o });
  const want = { token: "WPROS", to: "0xBB", raw: 100n, dueAt: 900 };
  assert.equal(matchPayment([t({})], want, new Set())?.tx, "0x1");
  assert.equal(matchPayment([t({ value: 99n })], want, new Set()), undefined);
  assert.equal(matchPayment([t({ time: 800 })], want, new Set()), undefined); // before it was due
  assert.equal(matchPayment([t({ token: "USDC" })], want, new Set()), undefined);
  const used = usedTxs([{ event: "paid", tx: "0x1", logIndex: 0 }]);
  assert.equal(matchPayment([t({})], want, used), undefined); // already credited to another instance
  // two identical weekly payments: the earliest unused one is taken
  assert.equal(matchPayment([t({ tx: "0x2", time: 2000 }), t({ tx: "0x1" })], want, new Set())?.tx, "0x1");
});

test("instance ids are per schedule and due day", () => {
  assert.equal(instanceId({ id: "rent" }, ts("2026-10-20T00:00:00Z")), "rent@2026-10-20");
});
