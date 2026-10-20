#!/usr/bin/env node
// The owner's signer, run by the owner (the agent never signs):
//   node --env-file=.env doc-grounded-builder/sign.mjs doc-grounded-builder/out/<id>.json
// Signs exactly the prepared transaction (nonce, to, value, data, gas, gas price) and broadcasts it through Chain MCP.
// Refuses if it was already sent, if the key is not the prepared sender, or if that nonce is already used.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { txLink } from "../lib/pharos.mjs";
import { nonceOf } from "../lib/payment.mjs";

const file = process.argv[2];
const sentFile = file.replace(/\.json$/, ".sent.json");
if (existsSync(sentFile)) {
  console.log(`refused: already sent (${JSON.parse(readFileSync(sentFile, "utf8")).hash})`);
  process.exit(1);
}
const u = JSON.parse(readFileSync(file, "utf8")).unsigned;
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
if (account.address.toLowerCase() !== u.from.toLowerCase()) throw new Error(`this key is ${account.address}, the transaction is from ${u.from}`);

const mcp = await connect();
try {
  const used = await nonceOf(mcp, u.from, "latest");
  if (used > u.nonce) {
    console.log(`refused: nonce ${u.nonce} is already used (account nonce is ${used}); prepare it again`);
    process.exitCode = 1;
  } else {
    const raw = await account.signTransaction({ chainId: u.chainId, type: "legacy", to: u.to, value: BigInt(u.value), data: u.data, nonce: u.nonce, gas: BigInt(u.gas), gasPrice: BigInt(u.gasPrice) });
    const r = await mcp.call("send_raw_transaction", { rawTransaction: raw });
    const hash = typeof r === "string" ? r : r.txHash ?? r.hash;
    writeFileSync(sentFile, JSON.stringify({ hash, sentAt: new Date().toISOString() }, null, 1));
    console.log(`sent ${txLink(hash)}`);
    for (let i = 0; i < 30; i++) {
      const rc = await mcp.call("get_transaction_receipt", { hash }).catch(() => null);
      if (rc?.status) {
        console.log(`  ${rc.status === "0x1" ? "success" : "REVERTED"} in block ${Number(BigInt(rc.blockNumber))}; now: node doc-grounded-builder/builder.mjs verify ${file}`);
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
} finally {
  await mcp.close();
}
