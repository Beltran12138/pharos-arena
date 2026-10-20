import { test } from "node:test";
import assert from "node:assert/strict";
import { usdcUnits } from "../x402-paywalled-api/config.mjs";
import { canPay, fold, nextItem, resolveUnknown, spent } from "../x402-agent-buyer/budget.mjs";

const limits = { budget: 10_000n, cap: 5_000n }; // $0.01 budget, $0.005 per call

test("USD prices to USDC base units without float drift", () => {
  assert.equal(usdcUnits("0.001"), 1000n);
  assert.equal(usdcUnits("$0.005"), 5000n);
  assert.equal(usdcUnits("1"), 1_000_000n);
  assert.equal(usdcUnits("0.000001"), 1n);
  assert.throws(() => usdcUnits("0.0000001"), /decimals/);
});

test("per-call cap and budget: refuse over the cap (keep going), stop at the budget", () => {
  assert.equal(canPay(5000n, limits, []).ok, true);
  const over = canPay(5001n, limits, []);
  assert.equal(over.ok, false);
  assert.equal(over.stop, false);
  const ledger = [{ nonce: "0x1", amount: "5000", status: "settled" }, { nonce: "0x2", amount: "2000", status: "settled" }];
  assert.equal(canPay(3000n, limits, ledger).ok, true); // exactly the budget
  const atBudget = canPay(3001n, limits, ledger);
  assert.equal(atBudget.ok, false);
  assert.equal(atBudget.stop, true);
});

test("ledger: a nonce counts once however many times it is logged; in-flight counts, not-settled doesn't", () => {
  const ledger = [
    { nonce: "0xa", amount: "1000", status: "in-flight" },
    { nonce: "0xa", status: "settled", tx: "0xt1" }, // the same payment, resolved
    { nonce: "0xa", status: "settled", tx: "0xt1" }, // logged again (a retry that found it on chain)
    { nonce: "0xb", amount: "5000", status: "in-flight" }, // answer still unknown: counted, so the budget holds
    { nonce: "0xc", amount: "2000", status: "in-flight" },
    { nonce: "0xc", status: "not-settled" }, // never went through: not counted
  ];
  assert.equal(spent(ledger), 6000n);
  assert.equal(fold(ledger)["0xa"].amount, "1000");
  assert.equal(fold(ledger)["0xa"].tx, "0xt1");
  // an in-flight payment blocks spending past the budget
  assert.equal(canPay(4001n, limits, ledger).ok, false);
});

test("buying order: required first, optional after, nothing bought twice", () => {
  const items = [
    { resource: "/price", required: false },
    { resource: "/morpho/A", required: true },
    { resource: "/morpho/B", required: true },
  ];
  assert.equal(nextItem(items, new Set()).resource, "/morpho/A");
  assert.equal(nextItem(items, new Set(["/morpho/A"])).resource, "/morpho/B");
  assert.equal(nextItem(items, new Set(["/morpho/A", "/morpho/B"])).resource, "/price");
  assert.equal(nextItem(items, new Set(["/morpho/A", "/morpho/B", "/price"])), null);
});

test("unknown outcome: the chain decides; only the same signed payment is ever resent", () => {
  assert.equal(resolveUnknown({ onChainUsed: true, attempts: 1 }).action, "record-settled");
  assert.equal(resolveUnknown({ onChainUsed: false, attempts: 1 }).action, "resend-same");
  assert.equal(resolveUnknown({ onChainUsed: false, attempts: 3 }).action, "give-up");
  assert.equal(resolveUnknown({ onChainUsed: true, attempts: 9 }).action, "record-settled");
  // the server refused the request itself (e.g. 400): do not resend, nothing was paid
  assert.equal(resolveUnknown({ onChainUsed: false, attempts: 1, rejectedStatus: 400 }).action, "give-up");
  // ... unless the chain says it was paid anyway
  assert.equal(resolveUnknown({ onChainUsed: true, attempts: 1, rejectedStatus: 400 }).action, "record-settled");
});

test("once a required item can't be had, optional context is not bought", () => {
  const items = [{ resource: "/morpho/A", required: true }, { resource: "/price", required: false }];
  // /morpho/A was refused (over the cap): it is filtered out by the caller, and requiredMissing is set
  assert.equal(nextItem(items.filter((i) => i.required === false), new Set(), true), null);
  assert.equal(nextItem(items.filter((i) => i.required === false), new Set(), false).resource, "/price");
});
