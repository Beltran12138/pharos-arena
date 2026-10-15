#!/usr/bin/env node
// dApp Support Agent (Pharos Agent Arena, Easy): give it a transaction hash, it tells you in plain words why
// the transaction failed and what to do about it. Diagnosis logic: diagnose.mjs.
//
//   node dapp-support-agent/explain.mjs <txHash> [--json]
import { connect } from "../lib/mcp.mjs";
import { diagnose, render } from "./diagnose.mjs";

const args = process.argv.slice(2);
const hash = args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
const asJson = args.includes("--json");
if (!hash) {
  console.error("usage: explain.mjs <txHash> [--json]");
  process.exit(2);
}

const mcp = await connect();
try {
  const d = await diagnose(mcp, hash);
  console.log(asJson ? JSON.stringify(d, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : render(d));
} finally {
  await mcp.close();
}

