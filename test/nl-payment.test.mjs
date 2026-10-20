import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransaction } from "viem";
import { answer, parse } from "../natural-language-payment/parse.mjs";
import { buildCall, toRaw, BY_SYMBOL } from "../lib/payment.mjs";

const contacts = { alice: "0x00000000000000000000000000000000000a11ce", alicia: "0x000000000000000000000000000000000a11c1a0", bob: "0x0000000000000000000000000000000000000b0b" };
const fields = (t) => parse(t, contacts).questions.map((q) => q.field);

test("a complete request needs no questions", () => {
  const r = parse("send 0.0002 WPROS to alice", contacts);
  assert.deepEqual([r.amount, r.symbol, r.recipient.address, r.questions.length], ["0.0002", "WPROS", contacts.alice, 0]);
  assert.equal(parse("Send 1,250.5 USDC to 0x00000000000000000000000000000000000a11ce", contacts).amount, "1250.5");
});

test("ambiguity becomes a question, never a guess", () => {
  assert.deepEqual(fields("send 100 USDC to alice.eth"), ["recipient"]); // no ENS on Pharos; .eth is not a token
  assert.deepEqual(fields("pay ali $0.5"), ["recipient", "token"]); // two contacts match; $ is not a token
  assert.deepEqual(fields("send 1.5k PROS to bob"), ["amount"]);
  assert.match(parse("send 1.5k PROS to bob", contacts).questions[0].ask, /1500/);
  assert.deepEqual(fields("send 0.1 WPROS and 0.2 WPROS to bob"), ["amount"]);
  assert.deepEqual(fields("send 5 ETH to bob"), ["token"]);
  assert.deepEqual(fields("send 5 USDC to carol"), ["recipient"]); // not a contact
  assert.deepEqual(fields("send USDC to bob"), ["amount"]);
  assert.deepEqual(fields("send 5 USDC to 0x123"), ["recipient"]); // truncated address
});

test("answers fill the field; a bare yes picks the single offered option; nonsense is refused", () => {
  const r = parse("send 100 USDC to alice.eth", contacts);
  assert.equal(answer(r, r.questions[0], "yes", contacts).recipient.address, contacts.alice);
  assert.ok(answer(r, r.questions[0], "dave", contacts).error);
  const two = parse("pay ali $0.5", contacts);
  assert.equal(answer(two, two.questions[0], "yes", contacts).error !== undefined, true); // two options: "yes" is not a choice
  assert.equal(answer(two, two.questions[0], "alicia", contacts).recipient.address, contacts.alicia);
});

test("amounts are exact: more decimals than the token has is refused, not rounded", () => {
  assert.equal(toRaw("1.5", 6), 1_500_000n);
  assert.throws(() => toRaw("0.0000001", 6), /7 decimals/);
});

test("the prepared call decodes back to the same payment, and a memo rides after the ERC-20 arguments", () => {
  const c = buildCall({ token: BY_SYMBOL.USDC, to: contacts.bob, raw: 2_500_000n, memo: "INV-7" });
  assert.equal(c.to.toLowerCase(), BY_SYMBOL.USDC.address);
  assert.equal(c.data.slice(0, 10), "0xa9059cbb");
  assert.equal(BigInt("0x" + c.data.slice(74, 138)), 2_500_000n);
  assert.equal(Buffer.from(c.data.slice(138), "hex").toString(), "INV-7");
  const n = buildCall({ token: BY_SYMBOL.PROS, to: contacts.bob, raw: 10n ** 18n });
  assert.deepEqual([n.to, n.value, n.data], [contacts.bob, 10n ** 18n, "0x"]);
});

test("serialized unsigned legacy tx round-trips with chain id 1672", async () => {
  const { serializeTransaction } = await import("viem");
  const s = serializeTransaction({ chainId: 1672, type: "legacy", to: contacts.bob, value: 1n, data: "0x", nonce: 2, gas: 21000n, gasPrice: 10n ** 10n });
  const p = parseTransaction(s);
  assert.deepEqual([p.chainId, p.nonce, p.to.toLowerCase(), p.value], [1672, 2, contacts.bob, 1n]);
});
