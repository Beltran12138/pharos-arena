#!/usr/bin/env node
// x402 Agent Buyer (Pharos Agent Arena, Hard): an agent that pays for the data it uses. Job: a liquidation-risk
// report on Morpho Blue borrowers. It buys from x402-paywalled APIs on Pharos Atlantic (our seller's three paid
// routes), reads each price from the 402 itself, buys required items first and optional ones only if the budget
// allows, refuses anything over the per-call cap, stops at the budget, and keeps a ledger keyed by the EIP-3009
// nonce so that a retried payment never counts twice.
//
//   node --env-file=.env.atlantic x402-agent-buyer/agent.mjs --borrowers 0x…,0x… --budget 0.02 --cap 0.006
//        [--api http://localhost:4021] [--lose-response <n>]   (drop the answer to the n-th paid request, as if
//                                                               the connection broke after the server settled)
import { appendFileSync, mkdirSync } from "node:fs";
import { formatUnits, getAddress, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORK, USDC, atlantic, atlanticTx, need, usdcUnits } from "../x402-paywalled-api/config.mjs";
import { canPay, fold, nextItem, resolveUnknown, spent } from "./budget.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const API = opt("--api", "http://localhost:4021");
// (a) => getAddress(a), not .map(getAddress): map would pass the index as getAddress's chainId (EIP-1191 checksum)
const borrowers = opt("--borrowers", "").split(",").filter(Boolean).map((a) => getAddress(a));
const limits = { budget: usdcUnits(opt("--budget", "0.02")), cap: usdcUnits(opt("--cap", "0.006")) };
const loseAt = Number(opt("--lose-response", 0));
const AUTH_STATE = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const AUTH_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

const buyer = privateKeyToAccount(need("BUYER_PRIVATE_KEY"));
const chain = atlantic();
const xc = new x402Client();
xc.register(NETWORK, new ExactEvmScheme(buyer));
// The SDK only pays in tokens it knows by default; allow Circle's Atlantic USDC. Its own cap is a backstop at the
// agent's per-call cap; the agent checks the cap and the budget itself before signing (budget.mjs).
xc.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDC.address, maxAmountPerPayment: String(limits.cap) }] });
const http = new x402HTTPClient(xc);
const u = (x) => `$${formatUnits(BigInt(x), USDC.decimals)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const job = `job-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
mkdirSync(new URL("./ledger/", import.meta.url), { recursive: true });
const ledgerFile = new URL(`./ledger/${job}.jsonl`, import.meta.url);
const ledger = [];
const record = (e) => {
  const line = { t: new Date().toISOString(), job, ...e };
  ledger.push(line);
  appendFileSync(ledgerFile, JSON.stringify(line) + "\n");
};

console.log(`${job}: Morpho liquidation-risk report for ${borrowers.length} borrower(s); budget ${u(limits.budget)}, per-call cap ${u(limits.cap)}; buyer ${buyer.address}`);
console.log(`  ledger: x402-agent-buyer/ledger/${job}.jsonl\n`);

// ── plan: what the report needs, from the seller's free catalog ──
const catalog = await (await fetch(`${API}/catalog`)).json();
const listed = (route) => catalog.routes.find((r) => r.route === route);
const items = [
  ...borrowers.map((a) => ({ resource: `/v1/morpho/${a}`, route: "GET /v1/morpho/:address", required: true, why: `positions and health factor of ${a}` })),
  { resource: "/v1/pros-price", route: "GET /v1/pros-price", required: false, why: "PROS/USD (Chainlink), to state the market context" },
  { resource: "/v1/pool/wpros-usdc", route: "GET /v1/pool/wpros-usdc", required: false, why: "pool price, to cross-check the oracle against the market" },
];
console.log("Plan (catalog prices; the price paid is the one in each 402):");
for (const i of items) console.log(`  ${i.required ? "required" : "optional"}  ${("$" + (listed(i.route)?.priceUsd ?? "?")).padEnd(7)} ${i.resource} — ${i.why}`);
const requiredCost = items.filter((i) => i.required).reduce((s, i) => s + usdcUnits(listed(i.route).priceUsd), 0n);
console.log(`  required items: ${u(requiredCost)} of the ${u(limits.budget)} budget${requiredCost > limits.budget ? " — the budget cannot cover every borrower" : ""}\n`);

// ── buy ──
const bought = new Map();
const skipped = [];
let paidRequests = 0;
let stopped = null;
const requiredMissing = () => skipped.some((i) => i.required);
for (let item; (item = nextItem(items.filter((i) => !skipped.includes(i)), new Set(bought.keys()), requiredMissing())); ) {
  const r = await buy(item);
  if (r.data) bought.set(item.resource, r.data);
  else if (r.stop) { stopped = r.why; break; }
  else if (r.skip) skipped.push(item);
}
// Optional items left unbought because the report can't be complete: say so, they were not worth the money.
for (const i of items.filter((i) => !i.required && !bought.has(i.resource) && !skipped.includes(i)))
  if (requiredMissing() || stopped) { i.skipWhy = stopped ? "not bought: the job stopped at the budget" : "not bought: required data is missing, so this context is not worth paying for"; skipped.push(i); console.log(`  SKIPPED ${i.resource} (optional): ${i.skipWhy}`); }

// ── report ──
console.log(`\nReport`);
for (const a of borrowers) {
  const d = bought.get(`/v1/morpho/${a}`);
  if (!d) { console.log(`  ${a}: NOT BOUGHT — no data`); continue; }
  if (!d.positions.length) console.log(`  ${a}: no Morpho positions (${d.marketsChecked} markets, block ${d.source.block})`);
  for (const p of d.positions) {
    const hf = p.healthFactor;
    console.log(`  ${a}: ${p.market} — borrowed ${p.borrowed.toLocaleString("en-US", { maximumFractionDigits: 2 })}, HF ${hf == null ? "n/a (no borrow)" : hf.toFixed(4)}${hf != null ? ` → ${hf < 1.01 ? "CRITICAL" : hf < 1.05 ? "at risk" : "ok"}; liquidation if collateral falls ${((1 - 1 / hf) * 100).toFixed(2)}%` : ""} (block ${d.source.block})`);
  }
}
const price = bought.get("/v1/pros-price"), pool = bought.get("/v1/pool/wpros-usdc");
if (price) console.log(`  PROS/USD (Chainlink): $${price.price.toFixed(4)}, ${price.ageSeconds} s old`);
if (price && pool) console.log(`  pool vs oracle: pool $${pool.priceUsdcPerWpros.toFixed(4)}, ${(((pool.priceUsdcPerWpros - price.price) / price.price) * 100).toFixed(2)}% from the oracle`);
for (const i of skipped) console.log(`  skipped ${i.resource}: ${i.skipWhy}`);
const settled = Object.values(fold(ledger)).filter((e) => e.status === "settled");
console.log(`\nPaid ${settled.length} time(s), total ${u(spent(ledger))} of ${u(limits.budget)}; every payment: ${settled.map((e) => `${e.resource} ${u(e.amount)} ${(e.tx ?? "tx ?").slice(0, 10)}…`).join(", ") || "none"}`);
console.log(stopped ? `→ STOPPED at the budget: ${stopped}` : `→ JOB DONE${borrowers.every((a) => bought.has(`/v1/morpho/${a}`)) ? "" : " (incomplete)"}`);
if (stopped) process.exitCode = 2;

/** One item: 402 → price checks → sign → pay → verify; failures resolved by the nonce, never paid twice. */
async function buy(item) {
  const url = API + item.resource;
  const first = await fetch(url);
  if (first.status !== 402) return first.ok ? { data: await first.json() } : { skip: true };
  const required = http.getPaymentRequiredResponse((h) => first.headers.get(h), await first.json().catch(() => ({})));
  const req = required.accepts.find((a) => a.network === NETWORK && a.asset.toLowerCase() === USDC.address.toLowerCase());
  if (!req || getAddress(req.payTo) !== getAddress(catalog.payTo)) return refuse(item, `the 402 asks for something else than the catalog (asset/network/payee)`, false);
  const listedPrice = usdcUnits(listed(item.route).priceUsd);
  if (BigInt(req.amount) !== listedPrice) console.log(`  note: ${item.resource} asks ${u(req.amount)}, the catalog says ${u(listedPrice)}; deciding on ${u(req.amount)}`);
  const ok = canPay(req.amount, limits, ledger);
  if (!ok.ok) return item.required && ok.stop ? { stop: true, why: `${item.resource} (${u(req.amount)}) ${ok.why}` } : refuse(item, ok.why, false);

  const payload = await http.createPaymentPayload({ ...required, accepts: [req] });
  const nonce = payload.payload.authorization.nonce;
  const headers = http.encodePaymentSignatureHeader(payload);
  const fromBlock = (await chain.getBlockNumber()) - 2n;
  record({ nonce, amount: req.amount, resource: item.resource, status: "in-flight" });
  console.log(`  pay ${u(req.amount)} for ${item.resource} (${item.why}); nonce ${nonce.slice(0, 12)}…, running total incl. this ${u(spent(ledger))}`);

  paidRequests++;
  for (let attempt = 1; ; attempt++) {
    let res = null;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      if (paidRequests === loseAt && attempt === 1) {
        await res.arrayBuffer();
        console.log(`    attempt ${attempt}: answer LOST (injected: dropped after the server answered ${res.status})`);
        res = null;
      }
    } catch (e) {
      console.log(`    attempt ${attempt}: ${e.message}`);
    }
    if (res?.status === 200 && res.headers.get("PAYMENT-RESPONSE")) {
      const settle = http.getPaymentSettleResponse((h) => res.headers.get(h));
      const data = await res.json();
      await confirm(settle.transaction, req);
      record({ nonce, status: "settled", tx: settle.transaction });
      console.log(`    settled ${atlanticTx(settle.transaction)} — bought ${item.resource}; running total ${u(spent(ledger))}`);
      return { data };
    }
    if (res) console.log(`    attempt ${attempt}: ${res.status}`);
    // Unknown outcome. The chain decides: is this nonce used?
    await sleep(3000);
    const used = await chain.readContract({ address: USDC.address, abi: AUTH_STATE, functionName: "authorizationState", args: [buyer.address, nonce] });
    const d = resolveUnknown({ onChainUsed: used, attempts: attempt, rejectedStatus: res && res.status >= 400 && res.status < 500 && res.status !== 402 ? res.status : null });
    console.log(`    authorizationState(buyer, nonce) = ${used} → ${d.why}`);
    if (d.action === "record-settled") {
      const [ev] = await chain.getLogs({ address: USDC.address, event: AUTH_USED, args: { authorizer: buyer.address, nonce }, fromBlock });
      record({ nonce, status: "settled", tx: ev?.transactionHash ?? null, note: "settled, answer lost" });
      console.log(`    the payment is ${ev ? atlanticTx(ev.transactionHash) : "on chain"}: counted once (running total ${u(spent(ledger))}); the data did not arrive, so the item is still missing`);
      return {}; // nextItem picks it again: a new purchase, with a new nonce, if the budget allows
    }
    if (d.action === "give-up") {
      record({ nonce, status: "not-settled" });
      return refuse(item, d.why, false);
    }
    await sleep(2000 * attempt); // resend-same
  }
}

function refuse(item, why, stop) {
  console.log(`  REFUSED ${item.resource} (${item.required ? "required" : "optional"}): ${why}`);
  item.skipWhy = why;
  return { skip: !stop, stop };
}

/** The facilitator's word is not enough: receipt and the USDC Transfer buyer → payee of the price. */
async function confirm(hash, req) {
  const rc = await chain.waitForTransactionReceipt({ hash });
  const ok = rc.status === "success" && rc.logs.some((l) => l.address.toLowerCase() === USDC.address.toLowerCase() && l.topics[1]?.endsWith(buyer.address.slice(2).toLowerCase()) && l.topics[2]?.endsWith(req.payTo.slice(2).toLowerCase()) && BigInt(l.data) === BigInt(req.amount));
  if (!ok) throw new Error(`settlement ${hash} does not show the expected USDC transfer`);
}
