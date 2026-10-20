import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, extract } from "../invoice-to-payment/extract.mjs";

const sample = (f) => readFileSync(new URL(`../invoice-to-payment/samples/${f}`, import.meta.url), "utf8");
const vendors = JSON.parse(readFileSync(new URL("../invoice-to-payment/vendors.json", import.meta.url), "utf8"));
const tokens = { "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0": "WPROS", "0xc879c018db60520f4355c26ed1a6d572cdac1815": "USDC" };
const ctx = (over = {}) => ({ vendors, tokens, today: "2026-10-20", prepared: new Map(), ...over });
const flags = (inv, c = ctx()) => check(inv, c).filter((i) => i.level === "error").map((i) => i.field);

test("three formats extract the same fields", () => {
  const t = extract(sample("01-design-studio.txt"));
  assert.deepEqual([t.format, t.reference, t.payee.name, t.total, t.currency, t.items.length, t.chainId], ["text", "INV-2026-0142", "Lighthouse Design Studio", 0.0003, "WPROS", 2, 1672]);
  const j = extract(sample("02-node-ops.json"));
  assert.deepEqual([j.format, j.reference, j.payee.address, j.total, j.currency, j.chainId], ["json", "HNO-7731", "0x0000000000000000000000000000000000000b0b", 0.0002, "PROS", 1672]);
  const u = extract(sample("03-payment-request.uri"));
  assert.deepEqual([u.format, u.reference, u.rawAmount, u.chainId], ["eip681", "LDS-REQ-88", "150000000000000", 1672]);
  assert.deepEqual(flags(u), []);
  assert.deepEqual([u.currency, u.total], ["WPROS", 0.00015]); // resolved from the token contract by check()
});

test("clean invoices have no blocking flags", () => {
  assert.deepEqual(flags(extract(sample("01-design-studio.txt"))), []);
  assert.deepEqual(flags(extract(sample("02-node-ops.json"))), []);
});

test("mismatches and missing fields are flagged, not repaired", () => {
  const bad = check(extract(sample("04-bad-totals.txt")), ctx());
  assert.deepEqual(bad.filter((i) => i.level === "error").map((i) => i.detail), ["line items add up to 160, but the total says 150", '"Copy edits": 3 × 15 = 45, not 40']);
  assert.ok(bad.some((i) => i.field === "due" && i.level === "warn"));
  assert.deepEqual(flags(extract(sample("05-redirected-payee.json"))), ["payee"]); // known vendor, different address
  assert.deepEqual(flags(extract(sample("06-no-token.txt"))), ["reference", "currency"]); // "USD" is not a token
  assert.deepEqual(flags(extract('{"invoiceNumber":"X1","total":5,"currency":"USDC","chainId":8453,"seller":{"wallet":"0x0000000000000000000000000000000000000b0b"}}')), ["network"]);
  assert.deepEqual(flags(extract("ethereum:0x1111111111111111111111111111111111111111@1672/transfer?address=0x0000000000000000000000000000000000000b0b&uint256=5")), ["currency", "reference"]); // unknown token contract
});

test("the same reference is not prepared twice", () => {
  const inv = extract(sample("01-design-studio.txt"));
  assert.deepEqual(flags(inv, ctx({ prepared: new Map([["INV-2026-0142", "2026-10-20"]]) })), ["reference"]);
});
