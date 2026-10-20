#!/usr/bin/env node
// Recurring Payment Agent (Pharos Agent Arena, Medium): rent / subscription / payroll-style payments on a
// weekly or monthly schedule. Each due payment is prepared as an unsigned transaction on time; its status
// (pending, paid, failed) is tracked in an append-only ledger and reconciled against the chain.
//
//   node recurring-payment/agent.mjs tick   [--config schedules.json]          prepare what is due, reconcile
//   node recurring-payment/agent.mjs status [--config schedules.json]          history + next payments
//   node recurring-payment/agent.mjs watch  [--interval 300] [--for s]         tick on a timer
//   node recurring-payment/agent.mjs release <instance>                       payer says it did not pay
//   node --env-file=.env recurring-payment/sign.mjs <prepared.json>             (the payer signs, not the agent)
//
// No double payment: (1) before preparing, the chain is searched for a transfer that already pays the
// instance; (2) an instance has at most one outstanding prepared transaction, with a fixed nonce, so signing it
// twice cannot pay twice; (3) each on-chain transfer is credited to one instance only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../lib/mcp.mjs";
import { EXPLORER_API, human, txLink } from "../lib/pharos.mjs";
import { BY_SYMBOL, jsonSafe, nonceOf, prepare, toRaw, validate } from "../lib/payment.mjs";
import { dueTimes, fold, instanceId, matchPayment, nextDue, usedTxs } from "./schedule.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cmd = args[0];
const cfg = JSON.parse(readFileSync(opt("--config", join(here, "schedules.json")), "utf8"));
const payer = cfg.payer.toLowerCase();
const ledgerPath = join(here, cfg.ledger ?? "ledger.jsonl");
const outDir = join(here, "out");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const readLedger = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const log = (e) => {
  appendFileSync(ledgerPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
  console.log(`  ${e.instance}: ${e.event}${e.reason ? ` (${e.reason})` : ""}${e.tx ? ` ${txLink(e.tx)}` : ""}${e.file ? ` → ${e.file}` : ""}${e.nonce != null ? ` nonce ${e.nonce}` : ""}`);
};

/**
 * Outgoing payments of the payer since `since`: discovered from the explorer's lists (token transfers, and
 * native-value transactions), each confirmed by its receipt through Chain MCP before it counts.
 */
async function outgoing(mcp, since) {
  const found = [];
  for (const kind of ["token_transfers", "transactions"]) {
    for (let page = 1; page < 20; page++) {
      const d = await (await fetch(`${EXPLORER_API}/address/${payer}/${kind}?size=50&page=${page}`)).json();
      for (const x of d.data) {
        const time = Date.parse(x.block_timestamp) / 1000;
        if (time < since || x.from_address !== payer) continue;
        if (kind === "token_transfers") {
          // By contract address: the explorer labels the WPROS contract's symbol as "PROS".
          const t = Object.values(BY_SYMBOL).find((k) => k.address === x.token_address?.toLowerCase());
          if (!t) continue;
          found.push({ token: t.symbol, to: x.to_address, value: toRaw(x.value, t.decimals), time, tx: x.transaction_hash, logIndex: x.log_index });
        } else if (x.value && Number(x.value) > 0) {
          // the explorer gives native value in PROS, not wei
          found.push({ token: "PROS", to: x.to_address, value: toRaw(x.value, 18), time, tx: x.hash, logIndex: -1 });
        }
      }
      if (d.data.length < 50 || Date.parse(d.data.at(-1).block_timestamp) / 1000 < since) break;
    }
  }
  const ok = [];
  for (const t of found) {
    const r = await mcp.call("get_transaction_receipt", { hash: t.tx });
    if (r?.status === "0x1") ok.push({ ...t, block: Number(BigInt(r.blockNumber)) });
  }
  return ok;
}

async function tick(mcp) {
  const now = Date.now() / 1000;
  const events = readLedger();
  const st = fold(events);
  const used = usedTxs(events);
  const due = cfg.schedules.flatMap((s) => dueTimes(s, now).map((t) => ({ s, t, id: instanceId(s, t) }))).filter((d) => st[d.id]?.status !== "paid");
  console.log(`${stamp()} tick: ${due.length} unpaid instance(s) due`);
  if (!due.length) return;

  const transfers = await outgoing(mcp, Math.min(...due.map((d) => d.t)));
  const latest = await nonceOf(mcp, payer, "latest");
  let nextNonce = Math.max(await nonceOf(mcp, payer, "pending"), ...Object.values(st).filter((x) => x.status === "pending").map((x) => x.prepared.nonce + 1));
  const reserved = {}; // tokens committed to outstanding prepared payments

  for (const { s, t, id } of due.sort((a, b) => a.t - b.t)) {
    const token = BY_SYMBOL[s.token];
    const raw = toRaw(s.amount, token.decimals);
    const cur = st[id];

    // 1. Already paid on chain (by the prepared tx or any other transfer that matches)?
    const hit = matchPayment(transfers, { token: s.token, to: s.to, raw, dueAt: t }, used);
    if (hit) {
      used.add(`${hit.tx}:${hit.logIndex ?? -1}`);
      log({ instance: id, event: "paid", tx: hit.tx, logIndex: hit.logIndex, block: hit.block, amount: s.amount, token: s.token });
      continue;
    }
    // 2. A prepared tx is outstanding. If its nonce has been used but no matching payment is found, it is
    //    NOT re-prepared: the payment may be there and not yet visible (indexer lag, or a lookup bug). It stays
    //    "unconfirmed" and is re-checked every tick; only the payer can release it (`release <instance>`).
    if (cur?.status === "pending" || cur?.status === "unconfirmed") {
      reserved[s.token] = (reserved[s.token] ?? 0n) + raw;
      if (latest > cur.prepared.nonce) {
        if (cur.status !== "unconfirmed") log({ instance: id, event: "unconfirmed", nonce: cur.prepared.nonce, reason: `nonce ${cur.prepared.nonce} is used but no matching payment was found yet; not re-preparing` });
        else console.log(`  ${id}: unconfirmed (nonce ${cur.prepared.nonce} used, payment not found); run "release ${id}" only if you know it did not pay`);
      } else console.log(`  ${id}: pending, waiting for the payer to sign ${cur.prepared.file} (nonce ${cur.prepared.nonce})`);
      continue;
    }
    // 3. Prepare it, if the payer can afford it on top of what is already committed.
    const v = await validate(mcp, { from: payer, to: s.to, symbol: s.token, amount: s.amount, memo: `${id}` });
    const blocking = v.checks.filter((c) => !c.ok);
    const free = v.have != null ? v.have - (reserved[s.token] ?? 0n) : null;
    if (!blocking.length && free != null && free < raw) blocking.push({ name: "balance", detail: `${human(free, token.decimals)} ${s.token} free after outstanding payments, needs ${s.amount}` });
    if (blocking.length) {
      log({ instance: id, event: "failed", reason: blocking.map((c) => `${c.name}: ${c.detail}`).join("; ") });
      continue;
    }
    const p = await prepare(mcp, v, payer, nextNonce++);
    mkdirSync(outDir, { recursive: true });
    const file = `out/${id.replace("@", "_")}.json`;
    writeFileSync(join(here, file), JSON.stringify(jsonSafe({ instance: id, schedule: s, dueAt: new Date(t * 1000).toISOString(), ...p }), null, 1));
    reserved[s.token] = (reserved[s.token] ?? 0n) + raw;
    log({ instance: id, event: "prepared", nonce: p.unsigned.nonce, file });
  }
}

function status() {
  const now = Date.now() / 1000;
  const events = readLedger();
  const st = fold(events);
  console.log(`Payer ${cfg.payer}\n`);
  for (const s of cfg.schedules) {
    console.log(`${s.id}: ${s.amount} ${s.token} to ${s.to} ${s.every} from ${s.start}${s.note ? ` (${s.note})` : ""}`);
    for (const t of dueTimes(s, now)) {
      const x = st[instanceId(s, t)];
      const line = !x
        ? "not processed yet"
        : x.status === "paid" ? `PAID ${txLink(x.tx)}`
        : x.status === "pending" ? `PENDING signature: ${x.prepared.file} (nonce ${x.prepared.nonce})`
        : x.status === "unconfirmed" ? `UNCONFIRMED: nonce ${x.prepared.nonce} used, payment not found yet`
        : x.status === "failed" ? `FAILED (attempt ${x.attempts}): ${x.reason}`
        : x.status;
      console.log(`  ${day(t)}  ${line}`);
    }
    console.log(`  next: ${day(nextDue(s, now))}\n`);
  }
}

if (cmd === "status") status();
else if (cmd === "release") {
  // The payer states that an unconfirmed instance did not pay; the next tick prepares it again.
  const id = args[1];
  const cur = fold(readLedger())[id];
  if (!cur || !["unconfirmed", "pending"].includes(cur.status)) throw new Error(`${id} is ${cur?.status ?? "unknown"}, nothing to release`);
  log({ instance: id, event: "stale", nonce: cur.prepared.nonce, reason: "released by the payer" });
}
else if (cmd === "tick" || cmd === "watch") {
  const mcp = await connect();
  try {
    const stopAt = opt("--for", null) ? Date.now() + Number(opt("--for")) * 1000 : Infinity;
    for (;;) {
      await tick(mcp);
      if (cmd === "tick" || Date.now() >= stopAt) break;
      await new Promise((r) => setTimeout(r, Number(opt("--interval", "300")) * 1000));
    }
  } finally {
    await mcp.close();
  }
} else {
  console.log("usage: agent.mjs tick | status | watch | release <instance> [--config schedules.json] [--interval s] [--for s]");
  process.exitCode = 2;
}
