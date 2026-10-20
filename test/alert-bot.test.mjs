import { test } from "node:test";
import assert from "node:assert/strict";
import { Seen, priceAlert, transferAlerts } from "../alert-bot/rules.mjs";

const log = (tx, i) => ({ transactionHash: tx, logIndex: `0x${i.toString(16)}`, blockNumber: "0x10" });
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("transfer rule: only values at or above the minimum alert, one id per log", () => {
  const rule = { id: "u", token: "USDC", min: "1000" };
  const logs = [log("0xaa", 1), log("0xaa", 2), log("0xbb", 0)];
  const decoded = [
    { from: A, to: B, value: 999_999999n },
    { from: A, to: B, value: 1000_000000n },
    { from: B, to: A, value: 25000_500000n },
  ];
  const out = transferAlerts(rule, logs, decoded);
  assert.deepEqual(out.map((a) => a.id), ["u:0xaa:2", "u:0xbb:0"]);
  assert.equal(out[1].value, "25,000.5 USDC");
  assert.match(out[1].link, /\/tx\/0xbb$/);
});

const feed = (price, updatedAt = 1) => ({ price, updatedAt, address: "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466" });

test("price rule alerts once per crossing and re-arms only after moving back past the margin", () => {
  const rule = { id: "p", pair: "PROS/USD", below: 0.55, rearmPct: 1 };
  let s;
  const step = (price, t) => {
    const r = priceAlert(rule, feed(price, t), s);
    s = r.state;
    return r.alert;
  };
  assert.equal(step(0.6, 1), null);
  assert.ok(step(0.549, 2)); // crosses
  assert.equal(step(0.54, 3), null); // still below: no repeat
  assert.equal(step(0.553, 4), null); // back above, but within 1%: stays disarmed
  assert.equal(step(0.549, 5), null); // so hovering at the line does not spam
  assert.equal(step(0.5556, 6), null); // > 0.5555: re-armed
  assert.ok(step(0.55, 7)); // threshold inclusive
});

test("price rule whose condition holds at start alerts once", () => {
  const r = priceAlert({ id: "p", pair: "PROS/USD", above: 0.62 }, feed(0.63));
  assert.equal(r.alert.id, "p:1");
  assert.equal(priceAlert({ id: "p", pair: "PROS/USD", above: 0.62 }, feed(0.64, 2), r.state).alert, null);
});

test("seen ids survive a restart and stay bounded", () => {
  const s = new Seen([], 3);
  ["a", "b", "c", "d"].forEach((id) => s.add(id));
  const restored = new Seen(JSON.parse(JSON.stringify(s)), 3);
  assert.equal(restored.has("a"), false);
  assert.equal(restored.has("d"), true);
});
