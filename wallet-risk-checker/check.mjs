#!/usr/bin/env node
// Wallet Risk Checker (Pharos Agent Arena, Medium): before you send funds to, approve, or call an address on
// Pharos, look at its on-chain history and flag what should make you pause.
//
//   node wallet-risk-checker/check.mjs <address> [--flagged wallet-risk-checker/flagged.json] [--json]
//
// Chain facts come from Chain MCP (get_code, get_balance, get_transaction_count, get_storage_at,
// get_transaction, get_block). History and contract metadata (creation time, verified source) come from the
// Pharos explorer API, which Chain MCP has no tool for.
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, erc20Abi } from "viem";
import { connect } from "../lib/mcp.mjs";
import { EXPLORER_API, NATIVE, addrLink, human, label } from "../lib/pharos.mjs";

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const MAX_UINT = 2n ** 256n - 1n;
const DAY = 86400;

const args = process.argv.slice(2);
const target = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase();
const flaggedPath = args.includes("--flagged") ? args[args.indexOf("--flagged") + 1] : new URL("./flagged.json", import.meta.url);
if (!target) {
  console.error("usage: check.mjs <address> [--flagged file.json] [--json]");
  process.exit(2);
}
const flagged = existsSync(flaggedPath) ? JSON.parse(readFileSync(flaggedPath, "utf8")) : {};
const flaggedMap = Object.fromEntries(Object.entries(flagged).map(([a, why]) => [a.toLowerCase(), why]));

async function explorer(path) {
  const r = await fetch(`${EXPLORER_API}${path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`explorer ${path}: HTTP ${r.status}`);
  return r.json();
}

const mcp = await connect();
const signals = [];
const add = (name, level, finding, explain) => signals.push({ name, level, finding, explain });
let isContract;
try {
  const { blockNumber } = await mcp.call("get_block_number");
  const now = Number(BigInt((await mcp.call("get_block", { block: blockNumber })).timestamp));
  const code = await mcp.call("get_code", { address: target, block: blockNumber });
  const codeHex = typeof code === "string" ? code : code.code ?? code.result;
  isContract = codeHex && codeHex !== "0x";
  const bal = BigInt((await mcp.call("get_balance", { address: target })).balanceWei);
  const nonce = Number((await mcp.call("get_transaction_count", { address: target })).nonce);

  const recent = await explorer(`/address/${target}/transactions?size=50&page=1`);
  const total = recent.total ?? 0;
  const txs = recent.data ?? [];
  // Oldest visible transaction: last page.
  const shown = Math.min(total, recent.max_display ?? total);
  const lastPage = Math.max(1, Math.ceil(shown / 50));
  const oldest = lastPage === 1 ? txs : (await explorer(`/address/${target}/transactions?size=50&page=${lastPage}`)).data ?? [];
  const firstSeen = oldest.length ? Math.min(...oldest.map((t) => Date.parse(t.block_timestamp) / 1000)) : null;
  const capped = total > shown;

  // ── signal: on the flagged list ──
  if (flaggedMap[target]) add("Flagged address", "high", `on your flagged list: ${flaggedMap[target]}`, "You (or a list you trust) marked this address as dangerous. Don't interact with it.");
  else add("Flagged address", "ok", `not on your flagged list (${Object.keys(flaggedMap).length} entries)`, "No match in the list of addresses you marked as dangerous.");

  if (isContract) {
    const meta = findMeta(txs, target)?.contract ?? findMeta(oldest, target)?.contract ?? null;
    // ── contract age ──
    const created = meta?.block_timestamp ? Date.parse(meta.block_timestamp) / 1000 : firstSeen;
    const ageDays = created ? (now - created) / DAY : null;
    if (ageDays === null) add("Contract age", "medium", "creation time unknown", "I couldn't find when this contract was created, so I can't tell how long it has been around.");
    else if (ageDays < 7) add("Contract age", "high", `deployed ${fmtAge(now - created)} ago${meta?.contract_creator ? ` by ${short(meta.contract_creator)}` : ""}`, "Brand-new contracts have no track record. Most scam and rug-pull contracts are used within days of deployment.");
    else if (ageDays < 30) add("Contract age", "medium", `deployed ${Math.floor(ageDays)} days ago`, "Fairly new contract: a short track record.");
    else add("Contract age", "ok", `deployed ${Math.floor(ageDays)} days ago (${meta?.block_timestamp?.slice(0, 10) ?? "?"})`, "It has been on chain for over a month.");
    // ── verified source ──
    if (meta?.is_verified === true) add("Verified source code", "ok", "source code verified on the explorer", "Anyone can read what the contract does.");
    else if (meta?.is_verified === false) add("Verified source code", "medium", "source code NOT verified", "Nobody can easily read what this contract does. You'd be trusting bytecode you can't inspect.");
    else add("Verified source code", "medium", "verification status unknown", "I couldn't confirm that the source code is published.");
    // ── upgradeability ──
    const impl = await mcp.call("get_storage_at", { address: target, position: EIP1967_IMPL });
    const implHex = String(impl.value ?? impl.result ?? impl);
    const upgradeable = /[1-9a-f]/i.test(implHex.slice(2));
    if (upgradeable) {
      const admin = await mcp.call("get_storage_at", { address: target, position: EIP1967_ADMIN });
      const adminAddr = "0x" + String(admin.value ?? admin.result ?? admin).slice(-40);
      add("Upgradeable", "low", `EIP-1967 proxy → implementation 0x${implHex.slice(-40)}${/[1-9a-f]/i.test(adminAddr.slice(2)) ? `, admin ${short(adminAddr)}` : ""}`, "Whoever controls the upgrade can replace the contract's code later, including after you've approved it.");
    } else add("Upgradeable", "ok", "not an EIP-1967 proxy", "Its code can't be swapped through the standard proxy slot.");
    // ── activity ──
    if (total < 10) add("Usage", "medium", `${total} transaction(s) ever`, "Almost nobody has used this contract yet.");
    else add("Usage", "ok", `${capped ? "more than " : ""}${shown.toLocaleString("en-US")} transactions`, "It is in active use.");
  } else {
    // ── wallet age / freshly funded ──
    const ageDays = firstSeen ? (now - firstSeen) / DAY : null;
    if (total === 0) add("Wallet history", "medium", "no transactions at all", "An empty, never-used address. Double-check it's the address you meant: a typo or a look-alike address is a common way to lose funds.");
    else if (!capped && ageDays !== null && ageDays < 2) add("Freshly funded", "high", `first seen ${fmtAge(now - firstSeen)} ago, ${total} tx`, "Wallets created hours ago that ask you for funds or approvals are typical of scams and airdrop farming.");
    else if (!capped && ageDays !== null && ageDays < 14) add("Freshly funded", "medium", `first seen ${Math.floor(ageDays)} days ago`, "A young wallet with a short history.");
    else add("Wallet age", "ok", `first seen ${capped ? "more than " : ""}${Math.floor(ageDays)} days ago, nonce ${nonce}`, "It has a history on Pharos.");
    // ── failed-transaction ratio ──
    const own = txs.filter((t) => t.from_address?.toLowerCase() === target);
    const failed = own.filter((t) => t.receipt_status === 0).length;
    if (own.length >= 10 && failed / own.length > 0.3) add("Failed transactions", "medium", `${failed} of its last ${own.length} transactions failed`, "Lots of failed transactions is typical of bots racing for trades, not of a person.");
    else add("Failed transactions", "ok", `${failed} of its last ${own.length} transactions failed`, "Normal.");
    // ── unusual approvals ──
    const approves = own.filter((t) => t.method_id === "0x095ea7b3").slice(0, 10);
    let unlimitedToUnverified = 0, unlimited = 0;
    for (const t of approves) {
      try {
        const tx = await mcp.call("get_transaction", { hash: t.hash });
        const { args: a } = decodeFunctionData({ abi: erc20Abi, data: tx.input });
        if (a[1] === MAX_UINT || a[1] > 10n ** 40n) {
          unlimited++;
          const spenderMeta = findMeta(txs, a[0].toLowerCase());
          if (spenderMeta?.contract?.is_verified === false) unlimitedToUnverified++;
        }
      } catch {
        // not a standard approve
      }
    }
    if (unlimitedToUnverified) add("Approvals", "medium", `${unlimited} unlimited approval(s) in recent history, ${unlimitedToUnverified} to unverified contracts`, "Unlimited approvals let a contract take that token at any time. To unverified contracts, that's a real risk to the wallet's funds.");
    else if (unlimited) add("Approvals", "low", `${unlimited} unlimited approval(s) in recent history`, "Common with DEXes, but each one is a standing permission to take that token.");
    else add("Approvals", "ok", `${approves.length} recent approval(s), none unlimited`, "No standing unlimited permissions in recent history.");
  }
  // ── counterparties on the flagged list ──
  const touched = new Set(txs.flatMap((t) => [t.from_address, t.to_address]).filter(Boolean).map((a) => a.toLowerCase()));
  const hits = [...touched].filter((a) => flaggedMap[a] && a !== target);
  if (hits.length) add("Interacted with flagged addresses", "high", hits.map((a) => `${short(a)} (${flaggedMap[a]})`).join(", "), "It has transacted with addresses you flagged. Funds may be linked to them.");
  else add("Interacted with flagged addresses", "ok", `none among ${touched.size} recent counterparties`, "No recent counterparty is on your flagged list.");

  // ── report ──
  const order = { high: 3, medium: 2, low: 1, ok: 0 };
  const worst = signals.reduce((m, s) => Math.max(m, order[s.level]), 0);
  const mediums = signals.filter((s) => s.level === "medium").length;
  const risk = worst === 3 || mediums >= 3 ? "HIGH" : worst === 2 ? "MEDIUM" : "LOW";
  const out = { address: target, type: isContract ? "contract" : "wallet", balance: `${human(bal, 18, 4)} ${NATIVE}`, risk, signals };
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Risk check: ${label(target)} (${target})`);
    console.log(`  ${addrLink(target)}`);
    console.log(`  ${out.type}, balance ${out.balance}, block ${Number(blockNumber).toLocaleString("en-US")}\n`);
    console.log(`RISK: ${risk}${risk !== "LOW" ? `  (${signals.filter((s) => s.level === "high" || s.level === "medium").map((s) => s.name).join(", ")})` : ""}\n`);
    const icon = { high: "✗ HIGH  ", medium: "! MEDIUM", low: "· low   ", ok: "✓ ok    " };
    for (const s of signals) console.log(`  ${icon[s.level]}  ${s.name}: ${s.finding}\n             ${s.explain}`);
  }
} finally {
  await mcp.close();
}

function findMeta(txs, addr) {
  for (const t of txs) {
    if (t.to_addr?.address?.toLowerCase() === addr) return t.to_addr;
    if (t.from_addr?.address?.toLowerCase() === addr) return t.from_addr;
  }
  return null;
}
function short(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function fmtAge(s) {
  return s < 3600 ? `${Math.round(s / 60)} min` : s < DAY ? `${(s / 3600).toFixed(1)} h` : `${(s / DAY).toFixed(1)} days`;
}
