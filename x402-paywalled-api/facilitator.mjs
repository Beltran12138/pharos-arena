#!/usr/bin/env node
// Our own x402 facilitator for Pharos Atlantic: /verify checks a payment (signature, amount, payee, time window,
// balance, nonce not used), /settle submits it on chain (USDC transferWithAuthorization, gas paid by this wallet),
// /supported lists what it handles. Every call is appended to facilitator-log.jsonl.
//
//   node --env-file=.env.atlantic x402-paywalled-api/facilitator.mjs
import express from "express";
import { appendFileSync } from "node:fs";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ATLANTIC, NETWORK, PORTS, atlanticTx, need } from "./config.mjs";

const account = privateKeyToAccount(need("FACILITATOR_PRIVATE_KEY"));
const client = createWalletClient({ account, chain: ATLANTIC, transport: http(undefined, { timeout: 30_000 }) }).extend(publicActions);
const signer = toFacilitatorEvmSigner({
  address: account.address,
  getCode: (a) => client.getCode(a),
  readContract: (a) => client.readContract({ ...a, args: a.args || [] }),
  verifyTypedData: (a) => client.verifyTypedData(a),
  writeContract: (a) => client.writeContract({ ...a, args: a.args || [] }),
  sendTransaction: (a) => client.sendTransaction(a),
  waitForTransactionReceipt: (a) => client.waitForTransactionReceipt(a),
});
const facilitator = new x402Facilitator();
facilitator.register(NETWORK, new ExactEvmScheme(signer, { deployERC4337WithEIP6492: true }));

const log = (e) => appendFileSync(new URL("./facilitator-log.jsonl", import.meta.url), JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");
const who = (p) => p?.payload?.authorization ? `${p.payload.authorization.from} → ${p.payload.authorization.to}, ${p.payload.authorization.value} units` : "?";

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  try {
    const r = await facilitator.verify(paymentPayload, paymentRequirements);
    log({ op: "verify", ok: r.isValid, reason: r.invalidReason, payment: who(paymentPayload) });
    console.log(`verify  ${r.isValid ? "valid  " : `INVALID (${r.invalidReason})`} ${who(paymentPayload)}`);
    res.json(r);
  } catch (e) {
    log({ op: "verify", error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  try {
    const r = await facilitator.settle(paymentPayload, paymentRequirements);
    log({ op: "settle", ok: r.success, tx: r.transaction, reason: r.errorReason, payment: who(paymentPayload) });
    console.log(`settle  ${r.success ? `ok ${atlanticTx(r.transaction)}` : `FAILED (${r.errorReason})`}`);
    res.json(r);
  } catch (e) {
    log({ op: "settle", error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get("/supported", (req, res) => res.json(facilitator.getSupported()));
app.get("/health", async (req, res) => res.json({ ok: true, network: NETWORK, signer: account.address, gasBalanceWei: String(await client.getBalance({ address: account.address })) }));

app.listen(PORTS.facilitator, () => console.log(`facilitator on http://localhost:${PORTS.facilitator} — ${NETWORK}, settles from ${account.address}`));
