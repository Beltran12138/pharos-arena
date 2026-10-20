#!/usr/bin/env node
// The payer's signer, run by the payer (the agent never signs):
//   node --env-file=.env recurring-payment/sign.mjs recurring-payment/out/<instance>.json
// Signs exactly the prepared transaction (same nonce, to, value, data, gas) and broadcasts it through Chain MCP.
// Refuses (before the key is even loaded) if the ledger says the instance is paid or this file was replaced by a
// newer preparation; and refuses if the key is not the prepared sender, or if that nonce is already used: the payment (or something
// else) already went out, so signing again could only fail or double-pay with a new nonce — it never re-nonces.
import { existsSync, readFileSync } from "node:fs";
import { fold } from "./schedule.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { txLink } from "../lib/pharos.mjs";
import { nonceOf } from "../lib/payment.mjs";

const file = process.argv[2];
const p = JSON.parse(readFileSync(file, "utf8"));
const u = p.unsigned;

// The ledger decides whether this file may still be signed: not if the instance is paid, and not if a newer
// preparation (another nonce) has replaced this one.
const ledger = new URL("./ledger.jsonl", import.meta.url);
const st = existsSync(ledger) ? fold(readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))[p.instance] : null;
if (st?.status === "paid") {
  console.log(`refused: ${p.instance} is already paid (${st.tx}).`);
  process.exit(1);
}
if (st?.prepared && st.prepared.nonce !== u.nonce) {
  console.log(`refused: this file (nonce ${u.nonce}) was replaced by a newer preparation (nonce ${st.prepared.nonce}).`);
  process.exit(1);
}
if (st && !st.prepared) {
  console.log(`refused: ${p.instance} has no outstanding preparation (status ${st.status}).`);
  process.exit(1);
}

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
if (account.address.toLowerCase() !== u.from.toLowerCase()) throw new Error(`this key is ${account.address}, the payment is from ${u.from}`);

const mcp = await connect();
try {
  const used = await nonceOf(mcp, u.from, "latest");
  if (used > u.nonce) {
    console.log(`refused: nonce ${u.nonce} is already used (account nonce is ${used}). ${p.instance} was already sent or replaced; run the agent's tick to reconcile.`);
    process.exitCode = 1;
  } else {
    const raw = await account.signTransaction({ chainId: u.chainId, type: "legacy", to: u.to, value: BigInt(u.value), data: u.data, nonce: u.nonce, gas: BigInt(u.gas), gasPrice: BigInt(u.gasPrice) });
    const r = await mcp.call("send_raw_transaction", { rawTransaction: raw });
    const hash = typeof r === "string" ? r : r.txHash ?? r.hash;
    console.log(`${p.instance}: sent ${txLink(hash)}`);
    for (let i = 0; i < 30; i++) {
      const rc = await mcp.call("get_transaction_receipt", { hash }).catch(() => null);
      if (rc?.status) {
        console.log(`  ${rc.status === "0x1" ? "success" : "REVERTED"} in block ${Number(BigInt(rc.blockNumber))}, gas ${Number(BigInt(rc.gasUsed))}`);
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
} finally {
  await mcp.close();
}
