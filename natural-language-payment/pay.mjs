#!/usr/bin/env node
// Natural-Language Payment Agent (Pharos Agent Arena, Medium): "send 100 USDC to alice" → questions where
// the request is ambiguous → validation on chain → a human-readable summary → an unsigned transaction and a
// wallet signing request. It never signs or sends.
//
//   node natural-language-payment/pay.mjs "<instruction>" --from 0x… [--contacts contacts.json] [--out dir]
//
// Questions and the final confirmation are read from stdin, one answer per line (type them, or pipe them).
// Validation (Chain MCP): token contract and decimals, recipient format/checksum/type, sender balance and
// gas, estimate_gas from the sender. Output: <out>/unsigned-<time>.json with the unsigned transaction, its
// RLP serialization (for wallets that sign raw), and an EIP-681 URI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect } from "../lib/mcp.mjs";
import { CHAIN_ID, human, short } from "../lib/pharos.mjs";
import { jsonSafe, prepare, validate } from "../lib/payment.mjs";
import { answer, parse } from "./parse.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const text = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const from = opt("--from");
const contacts = JSON.parse(readFileSync(opt("--contacts", new URL("./contacts.json", import.meta.url)), "utf8"));
const outDir = opt("--out", new URL("./out", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
if (!text || !/^0x[0-9a-fA-F]{40}$/.test(from ?? "")) {
  console.error('usage: pay.mjs "send 100 USDC to alice" --from 0x… [--contacts contacts.json]');
  process.exit(2);
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function ask(q) {
  console.log(`agent> ${q}`);
  const { value, done } = await lines.next();
  if (done) return null;
  console.log(`you>   ${value}`);
  return value;
}

console.log(`you>   ${text}`);
let req = parse(text, contacts);
for (const q of req.questions) {
  for (let tries = 0; ; tries++) {
    const reply = await ask(q.ask);
    if (reply == null) {
      console.log("agent> No answer, so nothing was prepared.");
      process.exit(3);
    }
    const next = answer(req, q, reply, contacts);
    if (!next.error) {
      req = next;
      break;
    }
    if (tries === 1) {
      console.log(`agent> ${next.error}. Stopping here; nothing was prepared.`);
      process.exit(3);
    }
    console.log(`agent> ${next.error}.`);
  }
}

const mcp = await connect();
try {
  const v = await validate(mcp, { from, to: req.recipient.address, symbol: req.symbol, amount: req.amount, memo: req.memo });
  const errors = v.checks.filter((c) => !c.ok);
  const who = req.recipient.name ? `${req.recipient.name} (${v.recipient ?? req.recipient.address})` : v.recipient ?? req.recipient.address;
  console.log("\nagent> Checks on Pharos mainnet (Chain MCP):");
  for (const c of v.checks) console.log(`         ${c.ok ? (c.level === "warn" ? "warn" : "ok  ") : "FAIL"} ${c.name}: ${c.detail}`);
  if (errors.length) {
    console.log(`\nagent> I can't prepare this: ${errors.map((c) => c.name).join(", ")} failed. Nothing was prepared.`);
    process.exitCode = 1;
  } else {
    const fee = ((v.gas * 12n) / 10n) * v.gasPriceWei;
    console.log(
      `\nagent> Summary:\n` +
        `         Send     ${human(v.raw, v.token.decimals)} ${req.symbol}\n` +
        `         To       ${who}\n` +
        `         From     ${from}\n` +
        `         Network  Pharos mainnet (chain ${CHAIN_ID})\n` +
        `         Max fee  ${human(fee, 18)} PROS (gas limit ${(v.gas * 12n) / 10n})\n` +
        (req.memo ? `         Memo     "${req.memo}" (in the calldata)\n` : "") +
        v.checks.filter((c) => c.level === "warn").map((c) => `         Note     ${c.detail}\n`).join(""),
    );
    const ok = await ask("Prepare this as an unsigned transaction for you to sign? (yes/no)");
    if (!/^(y|yes)$/i.test(ok?.trim() ?? "")) {
      console.log("agent> OK, nothing was prepared.");
    } else {
      const p = await prepare(mcp, v, from);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `unsigned-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}-${req.symbol}-${short(v.recipient).replace("…", "")}.json`);
      writeFileSync(file, JSON.stringify(jsonSafe({ request: text, summary: { amount: human(v.raw, v.token.decimals), token: req.symbol, to: v.recipient, name: req.recipient.name, from, memo: req.memo }, checks: v.checks, ...p }), null, 1));
      console.log(`agent> Unsigned transaction (not signed, not sent):`);
      console.log(`         to ${p.unsigned.to}  value ${p.unsigned.value}  nonce ${p.unsigned.nonce}  gas ${p.unsigned.gas}  gasPrice ${p.unsigned.gasPrice}`);
      console.log(`         data ${p.unsigned.data.length > 80 ? p.unsigned.data.slice(0, 80) + "…" : p.unsigned.data}`);
      console.log(`         wallet request: ${p.uri}`);
      console.log(`         saved: ${file}`);
    }
  }
} finally {
  await mcp.close();
  lines.return?.();
}
