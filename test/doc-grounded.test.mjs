import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { castSig, castValue, decimalsClaim, fill, ground, requestInputs, stepsFrom } from "../doc-grounded-builder/plan.mjs";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const registry = { url: "https://docs.pharos.xyz/getting-started/token-registry", text: `| WPROS | Wrapped PROS | ${WPROS} |\n| USDC | USDC | ${USDC} |` };
const network = { url: "https://docs.pharos.xyz/getting-started/network/pacific-mainnet", text: "RPC URL https://rpc.pharos.xyz chain ID 1672" };
const piggy = { url: "https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide", text: "function deposit() external payable { … } on the PiggyBank contract 0x1111111111111111111111111111111111111111" };

test("steps come from cast and curl commands in the answer, line continuations joined", () => {
  const body = 'Run:\n\n```bash\ncast call 0xc879c018db60520f4355c26ed1a6d572cdac1815 \\\n  "balanceOf(address)(uint256)" <ADDRESS> \\\n  --rpc-url https://rpc.pharos.xyz\n```\n\nand\n\n```sh\ncurl https://rpc.pharos.xyz -H \'Content-Type: application/json\' --data \'{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["<TRANSACTION_HASH>"],"id":1}\'\n```';
  const [call, rpc] = stepsFrom(body);
  assert.equal(call.kind, "call");
  assert.equal(call.to, USDC);
  assert.equal(call.fn.name, "balanceOf");
  assert.deepEqual(call.args, ["<ADDRESS>"]);
  assert.equal(call.rpc, "https://rpc.pharos.xyz");
  assert.equal(rpc.kind, "rpc");
  assert.equal(rpc.method, "eth_getTransactionReceipt");
  assert.deepEqual(rpc.params, ["<TRANSACTION_HASH>"]);
});

test("shell variables set in the block are substituted (export RPC=… then --rpc-url \"$RPC\")", () => {
  // shape of the Docs MCP answer of 2026-10-20 for "send 0.01 PROS"
  const body = '```bash\nexport RPC=https://rpc.pharos.xyz\ncast chain-id --rpc-url "$RPC"  # Confirm this prints 1672\n\ncast send 0x6649228a90bef932a1aa98e5c4412dadba8a04c5 \\\n  --value 10000000000000000 \\\n  --private-key "$PRIVATE_KEY" \\\n  --rpc-url "$RPC"\n```';
  const steps = stepsFrom(body);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "send");
  assert.equal(steps[0].rpc, "https://rpc.pharos.xyz");
  assert.equal(steps[0].value, 10n ** 16n);
  assert.equal(steps[0].fn, null);
});

test("cast send value and signatures parse; an answer with no command yields no step", () => {
  assert.equal(castValue("0.01ether"), 10n ** 16n);
  assert.equal(castValue("10gwei"), 10n ** 10n);
  assert.equal(castValue("1000"), 1000n);
  assert.equal(castSig("latestAnswer()(int256)").outputs[0].type, "int256");
  assert.equal(castSig("deposit()").inputs.length, 0);
  assert.deepEqual(stepsFrom("The docs don't document how to wrap PROS. The Token Registry lists WPROS."), []);
});

test("placeholders are filled from the request only; nothing is invented", () => {
  const step = { kind: "call", to: USDC, args: ["<ADDRESS>"] };
  const q = requestInputs("How do I check the USDC of 0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb?");
  assert.deepEqual(fill(step, q).step.args, ["0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb"]);
  assert.deepEqual(fill(step, requestInputs("How do I check a USDC balance?")).missing, ["<ADDRESS>"]);
  // a hash is not mistaken for an address
  const h = "0xa57f932d75c8fd7231e9da9c6d087dcd0a0c4eb6e6028500dba070965b8c9720";
  const r = requestInputs(`did ${h} succeed?`);
  assert.deepEqual(r.hashes, [h]);
  assert.deepEqual(r.addresses, []);
  assert.deepEqual(requestInputs("send 0.01 PROS to 0x6649228a90bef932a1aa98e5c4412dadba8a04c5").amount, { value: "0.01", symbol: "PROS" });
});

test("grounding: an ERC-20 function on a token the docs list is a standard; the request supplies its own address", () => {
  const step = { kind: "call", to: USDC, fn: castSig("balanceOf(address)(uint256)"), args: ["0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb"], rpc: "https://rpc.pharos.xyz" };
  const facts = ground(step, [registry, network], requestInputs("0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb"));
  assert.deepEqual(facts.map((f) => f.source), ["page", "standard", "request", "page"]);
});

test("grounding: a function found only on another contract's page does not count for this contract", () => {
  const step = { kind: "send", to: WPROS, fn: castSig("deposit()"), args: [], value: 10n ** 15n, rpc: "https://rpc.pharos.xyz" };
  const fn = ground(step, [registry, network, piggy], requestInputs("wrap 0.001 PROS")).find((f) => f.fact === "function");
  assert.equal(fn.source, "answer only");
  assert.match(fn.where, /piggybank.*does not list/);
  // with a page that documents deposit() for WPROS itself it would count
  const wprosPage = { url: "https://docs.pharos.xyz/x", text: `WPROS ${WPROS}: call deposit() with value` };
  assert.equal(ground(step, [registry, wprosPage], requestInputs("")).find((f) => f.fact === "function").source, "page");
});

test("grounding: the real answer that improvised deposit() for WPROS is refused, from its own caveat", () => {
  // Docs MCP answer of 2026-10-20 (doc-grounded-builder/runs/5-wrap-pros.txt, first run): a cast send it calls unconfirmed.
  const body = readFileSync(new URL("./fixtures/docs-answer-wrap-improvised.md", import.meta.url), "utf8");
  const [step] = stepsFrom(body);
  assert.equal(step.kind, "send");
  assert.equal(step.fn.name, "deposit");
  assert.equal(step.value, 10n ** 15n);
  const caveats = body.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/).filter((s) => /\bdocs?\b/i.test(s) && /\b(don[’']t|do not|not)\b/i.test(s));
  // even with the Piggy Bank page (which has a deposit()) fetched, the step stays unbacked
  const fn = ground(step, [registry, network, piggy], requestInputs("wrap 0.001 PROS"), caveats).find((f) => f.fact === "function");
  assert.equal(fn.source, "disclaimed");
});

test("grounding: a JSON-RPC method must appear on a docs page", () => {
  const rpcPage = { url: "https://docs.pharos.xyz/api-and-sdk/json-rpc-methods", text: "### eth_getTransactionReceipt\nReturns the receipt" };
  const step = { kind: "rpc", method: "eth_getTransactionReceipt", params: ["0xa57f932d75c8fd7231e9da9c6d087dcd0a0c4eb6e6028500dba070965b8c9720"], rpc: "https://rpc.pharos.xyz" };
  const q = requestInputs(step.params[0]);
  assert.deepEqual(ground(step, [rpcPage, network], q).map((f) => f.source), ["page", "request", "page"]);
  assert.equal(ground({ ...step, method: "eth_getBlockReceipts" }, [rpcPage, network], q)[0].source, "answer only");
});

test("the decimals an answer claims, in the wordings Docs MCP used", () => {
  assert.equal(decimalsClaim("The answer is scaled to **18 decimals**."), 18);
  assert.equal(decimalsClaim("USDC uses **6 decimal places**, so divide the result by `1,000,000`"), 6);
  assert.equal(decimalsClaim("Divide it by **1,000,000** for USDC; the x402 page specifies USDC’s six decimal places."), 6);
  assert.equal(decimalsClaim("Divide it by **1,000,000** for USDC."), 6);
  assert.equal(decimalsClaim("Divide the returned integer by `10^18` to get the USD price."), 18);
  assert.equal(decimalsClaim("The result is the raw balance."), null);
});
