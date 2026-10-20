#!/usr/bin/env node
// Invoice-to-Payment Agent (Pharos Agent Arena, Medium): read an invoice (plain text, JSON, or an EIP-681
// payment URI), flag anything missing or inconsistent, and prepare the matching unsigned payment with the
// invoice reference in its calldata. It never signs or sends.
//
//   node invoice-to-payment/invoice.mjs <invoice files…> --payer 0x… [--vendors vendors.json]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../lib/mcp.mjs";
import { CHAIN_ID, TOKENS, human } from "../lib/pharos.mjs";
import { jsonSafe, nonceOf, prepare, validate } from "../lib/payment.mjs";
import { check, extract } from "./extract.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const payer = opt("--payer");
const vendors = JSON.parse(readFileSync(opt("--vendors", join(here, "vendors.json")), "utf8"));
const preparedLog = join(here, "prepared.jsonl");
const prepared = new Map(existsSync(preparedLog) ? readFileSync(preparedLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((e) => [e.reference, e.at]) : []);
const tokens = Object.fromEntries(Object.entries(TOKENS).map(([a, t]) => [a, t.symbol]));

const mcp = await connect();
let nonce = null; // invoices prepared in one run get consecutive nonces, so all of them can be signed
try {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const inv = extract(text);
    const issues = check(inv, { vendors, tokens, today: new Date().toISOString().slice(0, 10), prepared });
    console.log(`\n════ ${basename(f)}  (format: ${inv.format})`);
    console.log(`  reference  ${inv.reference ?? "—"}`);
    console.log(`  payee      ${inv.payee.name ?? "—"}  ${inv.payee.address ?? "—"}`);
    console.log(`  amount     ${inv.total ?? "—"} ${inv.currency ?? "—"}${inv.items.length ? `  (${inv.items.length} line items)` : ""}`);
    console.log(`  due        ${inv.dueDate ?? "—"}    network ${inv.chainId ?? inv.network ?? "—"}`);
    for (const i of issues) console.log(`  ${i.level === "error" ? "FLAG" : "note"} ${i.field}: ${i.detail}`);

    if (issues.some((i) => i.level === "error")) {
      console.log("  → not prepared: fix or confirm the flagged fields with the payee first.");
      continue;
    }
    const amount = inv.rawAmount != null ? human(BigInt(inv.rawAmount), inv.currency === "USDC" ? 6 : 18, 18).replace(/,/g, "") : String(inv.total);
    const memo = `INV:${inv.reference}`;
    const v = await validate(mcp, { from: payer, to: inv.payee.address, symbol: inv.currency, amount, memo });
    const failed = v.checks.filter((c) => !c.ok);
    for (const c of v.checks) if (!c.ok || c.level === "warn") console.log(`  ${c.ok ? "note" : "FLAG"} ${c.name}: ${c.detail}`);
    if (failed.length) {
      console.log(`  → not prepared: ${failed.map((c) => c.name).join(", ")} failed on chain.`);
      continue;
    }
    nonce ??= await nonceOf(mcp, payer);
    const p = await prepare(mcp, v, payer, nonce++);
    const fee = p.unsigned.gas * p.unsigned.gasPrice;
    console.log(`  Payment summary: pay ${human(v.raw, v.token.decimals)} ${inv.currency} to ${inv.payee.name ?? "payee"} (${v.recipient}) for invoice ${inv.reference}, from ${payer}, on Pharos mainnet (chain ${CHAIN_ID}); max fee ${human(fee, 18)} PROS.`);
    console.log(`  The calldata carries "${memo}" after the transfer arguments, so the payment can be matched to the invoice on chain.`);
    mkdirSync(join(here, "out"), { recursive: true });
    const out = join("out", `${inv.reference}.json`);
    writeFileSync(join(here, out), JSON.stringify(jsonSafe({ invoice: basename(f), extracted: inv, issues, memo, ...p }), null, 1));
    appendFileSync(preparedLog, JSON.stringify({ at: new Date().toISOString(), reference: inv.reference, file: out }) + "\n");
    prepared.set(inv.reference, new Date().toISOString());
    console.log(`  → unsigned transaction (not signed, not sent): to ${p.unsigned.to}, nonce ${p.unsigned.nonce}, gas ${p.unsigned.gas}; ${out}`);
    console.log(`    wallet request: ${p.uri}`);
  }
} finally {
  await mcp.close();
}
