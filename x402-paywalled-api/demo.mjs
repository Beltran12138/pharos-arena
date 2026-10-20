#!/usr/bin/env node
// The full x402 flow against our seller, step by step, with each header decoded — then three payments that must be
// refused. Every settled payment is checked on Atlantic: receipt status and the USDC Transfer (buyer → seller, the
// exact price).
//
//   node --env-file=.env.atlantic x402-paywalled-api/demo.mjs        (facilitator.mjs and server.mjs running)
import { decodeEventLog, erc20Abi, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORK, PORTS, USDC, atlantic, atlanticTx, need } from "./config.mjs";

const BASE = `http://localhost:${PORTS.seller}`;
const buyer = privateKeyToAccount(need("BUYER_PRIVATE_KEY"));
const seller = getAddress(need("SELLER_ADDRESS"));
const chain = atlantic();
const client = new x402Client();
client.register(NETWORK, new ExactEvmScheme(buyer));
// The SDK only pays in tokens it knows by default; allow Circle's Atlantic USDC, at most $0.01 per payment.
client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDC.address, maxAmountPerPayment: "10000" }] });
const http = new x402HTTPClient(client);
const usdc = (a) => chain.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const fmt = (u) => `${formatUnits(BigInt(u), USDC.decimals)} USDC`;
const b64 = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`); };

console.log(`buyer ${buyer.address}, seller ${seller}, ${NETWORK}, USDC ${USDC.address}`);
const [b0, s0] = [await usdc(buyer.address), await usdc(seller)];
console.log(`balances before: buyer ${fmt(b0)}, seller ${fmt(s0)}\n`);

// ── free route ──
let r = await fetch(`${BASE}/health`);
console.log(`1. GET /health (free) → ${r.status}`);
check("free route answers 200 without payment", r.status === 200, JSON.stringify(await r.json()));

// ── two paid routes, full flow ──
const paid = [];
for (const [i, path] of [["2", "/v1/pros-price"], ["3", "/v1/pool/wpros-usdc"]]) {
  console.log(`\n${i}. GET ${path}`);
  const first = await fetch(BASE + path);
  const body = await first.json().catch(() => ({}));
  const required = http.getPaymentRequiredResponse((h) => first.headers.get(h), body);
  const req = required.accepts[0];
  console.log(`   → ${first.status}; PAYMENT-REQUIRED decoded: scheme ${req.scheme}, network ${req.network}, amount ${req.amount} (${fmt(req.amount)}), asset ${req.asset}, payTo ${req.payTo}, extra ${JSON.stringify(req.extra)}`);
  check("unpaid request gets 402 with PAYMENT-REQUIRED", first.status === 402 && !!first.headers.get("PAYMENT-REQUIRED"));

  const payload = await http.createPaymentPayload(required);
  const a = payload.payload.authorization;
  console.log(`   signed EIP-3009 authorization (no gas for the buyer): from ${a.from} to ${a.to}, value ${a.value}, valid ${a.validAfter}–${a.validBefore}, nonce ${a.nonce.slice(0, 18)}…`);
  const headers = http.encodePaymentSignatureHeader(payload);
  const second = await fetch(BASE + path, { headers });
  const data = await second.json();
  console.log(`   → ${second.status} with ${Object.keys(headers).join(", ")}; data: ${JSON.stringify(data).slice(0, 220)}…`);
  const pr = second.headers.get("PAYMENT-RESPONSE");
  check("paid request gets 200 with PAYMENT-RESPONSE", second.status === 200 && !!pr);
  if (!pr) continue;
  const settle = b64(pr);
  console.log(`   PAYMENT-RESPONSE decoded: success ${settle.success}, transaction ${settle.transaction}, network ${settle.network}, payer ${settle.payer}`);
  console.log(`   ${atlanticTx(settle.transaction)}`);
  // On chain, independently of the facilitator's word: receipt and the USDC Transfer it caused.
  const rc = await chain.waitForTransactionReceipt({ hash: settle.transaction });
  // The USDC logs also include AuthorizationUsed (EIP-3009); decode only the ERC-20 events.
  const t = rc.logs.filter((l) => l.address.toLowerCase() === USDC.address.toLowerCase()).flatMap((l) => { try { return [decodeEventLog({ abi: erc20Abi, ...l })]; } catch { return []; } }).find((e) => e.eventName === "Transfer");
  check("on chain: receipt success and USDC Transfer buyer → seller of exactly the price",
    rc.status === "success" && t && getAddress(t.args.from) === buyer.address && getAddress(t.args.to) === seller && t.args.value === BigInt(req.amount),
    `block ${rc.blockNumber}, Transfer ${t ? `${t.args.from} → ${t.args.to} ${fmt(t.args.value)}` : "none"}`);
  paid.push({ path, required, payload, headers, amount: BigInt(req.amount), tx: settle.transaction });
}

// ── payments that must be refused ──
const base = paid[0];
console.log(`\n4. Underpaid: sign for half the price of ${base.path}`);
const half = structuredClone(base.required);
half.accepts[0].amount = String(base.amount / 2n);
const under = await fetch(BASE + base.path, { headers: http.encodePaymentSignatureHeader(await http.createPaymentPayload(half)) });
check("underpaid payment gets 402 again", under.status === 402, `${under.status} ${reason(under)}`);

console.log(`\n5. Bad signature: a correct payment with one byte of the signature changed`);
const forged = structuredClone(await http.createPaymentPayload(base.required));
const sig = forged.payload.signature;
forged.payload.signature = sig.slice(0, -4) + (sig.slice(-4, -2) === "00" ? "01" : "00") + sig.slice(-2);
const bad = await fetch(BASE + base.path, { headers: http.encodePaymentSignatureHeader(forged) });
check("forged signature gets 402", bad.status === 402, `${bad.status} ${reason(bad)}`);

console.log(`\n6. Replay: send the payment already settled in step 2 again`);
const replay = await fetch(BASE + base.path, { headers: base.headers });
check("replayed payment gets 402 (its EIP-3009 nonce is used)", replay.status === 402, `${replay.status} ${reason(replay)}`);

const [b1, s1] = [await usdc(buyer.address), await usdc(seller)];
const spent = paid.reduce((x, p) => x + p.amount, 0n);
console.log(`\nbalances after: buyer ${fmt(b1)} (${fmt(b1 - b0)}), seller ${fmt(s1)} (+${fmt(s1 - s0)})`);
check("only the two good payments moved money", b0 - b1 === spent && s1 - s0 === spent, `expected ${fmt(spent)}`);
console.log(`\n→ ${results.every((x) => x.ok) ? "ALL CHECKS PASSED" : `${results.filter((x) => !x.ok).length} CHECK(S) FAILED`} (${results.length} checks)`);
if (!results.every((x) => x.ok)) process.exitCode = 1;

function reason(res) {
  const h = res.headers.get("PAYMENT-REQUIRED");
  try {
    return h ? `(${b64(h).error ?? "no reason"})` : "";
  } catch {
    return "";
  }
}
