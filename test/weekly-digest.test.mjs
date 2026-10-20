import { test } from "node:test";
import assert from "node:assert/strict";
import { lastCompleteStart, notable, priceOf, summarize } from "../weekly-digest/metrics.mjs";

const meta = { dec0: 18, dec1: 6, sym0: "WPROS", sym1: "USDC" };
const Q96 = 2n ** 96n;
// sqrtPriceX96 for 1 USDC per WPROS: raw price 1e-12 → sqrt 1e-6.
const ONE = Q96 / 1_000_000n;
const W = 10n ** 18n, U = 10n ** 6n;
const swap = (time, amount0, amount1, sqrt = ONE, recipient = "0xa") => ({ kind: "swap", time, tx: `0x${time}`, amount0, amount1, sqrtPriceX96: sqrt, recipient });

test("priceOf applies decimals: sqrt 1e-6·2^96 is 1.0 USDC per WPROS", () => {
  assert.ok(Math.abs(priceOf(ONE, 18, 6) - 1) < 1e-9);
  assert.ok(Math.abs(priceOf(ONE * 2n, 18, 6) - 4) < 1e-9);
});

test("summarize: volume from the USDC leg, net bought from the pool's sign convention", () => {
  const ev = [
    swap(100, 10n * W, -10n * U), // trader sold 10 WPROS for 10 USDC
    swap(200, -30n * W, 30n * U, ONE, "0xb"), // trader bought 30 WPROS for 30 USDC
    swap(300, 5n * W, -5n * U),
    { kind: "mint", time: 400, tx: "0xm", amount0: 100n * W, amount1: 50n * U },
  ];
  const s = summarize(ev, meta);
  assert.equal(s.swaps, 3);
  assert.equal(s.volumeUsd, 45);
  assert.equal(s.traders, 2);
  assert.equal(s.medianSwapUsd, 10);
  assert.equal(s.netBought0, 30 - 15);
  assert.equal(s.liquidityAddedUsd, 150); // 50 USDC + 100 WPROS at the close price 1.0
  assert.deepEqual(s.price, { open: 1, close: 1, high: 1, low: 1 });
});

test("notable: ranked by multiple of the period's median; one swap unless too few other candidates", () => {
  const ev = [];
  // Hourly price alternates ±1% (sqrt ±0.5%), except hour 30: sqrt 1.1/1.005 → about +19.8%, ~20× the median.
  for (let h = 0; h < 48; h++) {
    const sqrt = h === 30 ? (ONE * 1100n) / 1000n : (ONE * (1000n + BigInt(h % 2) * 5n)) / 1000n;
    ev.push(swap(h * 3600 + 10, 1n * W, -1n * U, sqrt));
  }
  ev.sort((a, b) => a.time - b.time);
  ev.splice(2, 0, swap(5000, 500n * W, -500n * U, ONE)); // 500× the median swap
  ev.splice(3, 0, swap(6000, 300n * W, -300n * U, ONE)); // 300×: must not take a second slot
  for (const [t, usdc] of [[7000, 100n], [7100, 1n], [7200, 1n]]) ev.push({ kind: "burn", time: t, tx: `0x${t}`, amount0: 0n, amount1: usdc * U });
  const top = notable(ev, meta);
  assert.deepEqual(top.map((t) => t.kind), ["swap", "burn", "price"]);
  assert.match(top[0].text, /^Largest swap: \$500/);
  assert.match(top[2].text, /\+19\.80%/);
  assert.ok(top[2].score > 15 && top[2].score < 25, `price score ${top[2].score}`);

  const few = notable([swap(10, 1n * W, -1n * U), swap(20, 9n * W, -9n * U), swap(30, 4n * W, -4n * U)], meta);
  // Nothing else qualifies (one hour, one day), so all three slots go to swaps, labelled by rank.
  assert.deepEqual(few.map((t) => t.text.split(":")[0]), ["Largest swap", "Large swap", "Large swap"]);
});

test("notable: a flat market does not make a small move 'infinitely' unusual", () => {
  const ev = [];
  for (let h = 0; h < 10; h++) ev.push(swap(h * 3600, 1n * W, -1n * U, h === 9 ? (ONE * 10001n) / 10000n : ONE)); // +0.02% once
  const price = notable(ev, meta).find((t) => t.kind === "price");
  assert.ok(price.score < 3, `score ${price.score}`); // 0.02% against the 0.01% floor
});

test("period calendar: the last period that has fully ended", () => {
  const anchor = Date.parse("2026-10-05T00:00:00Z") / 1000; // Monday
  const week = 7 * 86400;
  const now = Date.parse("2026-10-20T07:30:00Z") / 1000;
  assert.equal(new Date(lastCompleteStart(now, anchor, week) * 1000).toISOString(), "2026-10-12T00:00:00.000Z");
  const exactlyAtEnd = Date.parse("2026-10-19T00:00:00Z") / 1000;
  assert.equal(new Date(lastCompleteStart(exactlyAtEnd, anchor, week) * 1000).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(new Date(lastCompleteStart(now, anchor, 3600) * 1000).toISOString(), "2026-10-20T06:00:00.000Z");
});
