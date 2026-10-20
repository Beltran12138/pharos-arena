#!/usr/bin/env node
// Multi-Protocol Aggregator (Pharos Agent Arena, Hard): one interface over Morpho Blue and the tokenized vaults on
// Pharos mainnet. Queries (rates, positions) and actions (deposit, withdraw — prepared for signature), each routed
// to the best venue with the reason. One protocol failing does not stop the others.
//
//   node multi-protocol-aggregator/agg.mjs --user 0x… "rates for USDC" "deposit 5000 USDC" "withdraw 1000 USDC" …
//   … --down morpho      simulate Morpho being unavailable (its adapter throws), to show the fallback
import { readFileSync } from "node:fs";
import { getAddress, parseUnits, toHex } from "viem";
import { connect } from "../lib/mcp.mjs";
import { readFeed, revertReason } from "../lib/pharos.mjs";
import { gasUsd, rank } from "../yield-optimizer/rank.mjs";
import { morphoAdapter, vaultAdapter } from "./adapters.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const user = getAddress(opt("--user"));
const down = opt("--down", null);
const requests = args.filter((a, i) => !a.startsWith("--") && !["--user", "--down"].includes(args[i - 1]));
const reg = JSON.parse(readFileSync(new URL("../lib/protocols.json", import.meta.url), "utf8"));
const DEC = { USDC: 6, WPROS: 18 };
const fmt = (x, dp = 2) => x.toLocaleString("en-US", { maximumFractionDigits: dp });

const mcp = await connect();
try {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  const ctx = { mcp, block, now, user };
  const prices = { USDC: (await readFeed(mcp, "USDC/USD", block)).price, WPROS: (await readFeed(mcp, "PROS/USD", block)).price };
  const gas = { usdPerTx: gasUsd(150_000, (await mcp.call("get_gas_price")).gasPriceWei, prices.WPROS) };

  // Every adapter call goes through `guard`: a failure marks that protocol unavailable for this run and the
  // others carry on. --down makes one adapter fail on purpose.
  const unavailable = {};
  const guard = (a, key) => ({
    name: a.name, key,
    call: async (fn, ...xs) => {
      if (unavailable[key]) return null;
      try {
        if (down === key) throw new Error("simulated outage (--down)");
        return await a[fn](...xs);
      } catch (e) {
        unavailable[key] = `${a.name} unavailable: ${e.message.split("\n")[0].slice(0, 100)}`;
        return null;
      }
    },
  });
  const adapters = [guard(morphoAdapter(reg, ctx), "morpho"), guard(vaultAdapter(reg, ctx), "vaults")];
  const venues = async (asset) => (await Promise.all(adapters.map(async (a) => (await a.call("venues", asset)) ?? []))).flat();
  const adapterOf = (v) => adapters.find((a) => (v.protocol === "Morpho Blue" ? a.key === "morpho" : a.key === "vaults"));
  const notice = () => Object.values(unavailable).map((u) => `  ⚠ ${u} — answering with the other protocols only`).join("\n");

  console.log(`Aggregator over ${adapters.map((a) => a.name).join(" + ")}, block ${block}, user ${user}${down ? ` (simulating: ${down} down)` : ""}`);
  for (const q of requests) {
    console.log(`\n» ${q}`);
    const t = q.toLowerCase();
    let m;
    if ((m = /rates?(?: for)? (\w+)/.exec(t))) {
      const asset = m[1].toUpperCase();
      const vs = (await venues(asset)).sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
      if (notice()) console.log(notice());
      for (const v of vs) console.log(`  ${(v.apy == null ? "?" : v.apy.toFixed(2) + "%").padStart(7)}  ${v.label.padEnd(28)} ${v.protocol.padEnd(12)} exit: ${v.exit}${v.liquidity != null ? ` (${fmt(v.liquidity)} ${asset} available)` : ""}` +
        `${v.apy == null ? `\n           rate unknown: ${v.raw.apyUnknown}` : ""}\n           source: ${v.source}`);
    } else if (/positions?/.test(t)) {
      const ps = (await Promise.all(adapters.map(async (a) => (await a.call("positions", user)) ?? []))).flat();
      if (notice()) console.log(notice());
      if (!ps.length) console.log(`  no supply or vault positions for ${user} in the protocols that answered`);
      for (const p of ps) console.log(`  ${fmt(p.amount)} ${p.asset} in ${p.label} (${p.protocol}), earning ${p.apy?.toFixed(2) ?? "?"}%`);
    } else if ((m = /deposit ([\d.]+) (\w+)/.exec(t))) {
      const [amount, asset] = [Number(m[1]), m[2].toUpperCase()];
      const vs = (await venues(asset)).map((v) => ({ ...v, kind: v.protocol === "Morpho Blue" ? "morpho" : "vault", entryFeePct: v.entryFeePct ?? 0, exitFeePct: v.exitFeePct ?? 0, exitNote: v.exit, raw: v.protocol === "Morpho Blue" ? v.raw : v.raw }));
      if (notice()) console.log(notice());
      const r = rank(vs, { asset, amount, current: "wallet", holdDays: 30, minGainUsd: 0, assetUsd: prices[asset] }, gas);
      if (!r.best) {
        console.log(`  not routing: ${r.why}`);
        for (const o of r.options.slice(0, 5)) console.log(`    not ${o.venue.label}: ${o.excluded.join("; ") || "no readable yield"}`);
        continue;
      }
      const v = r.best.venue;
      console.log(`  route → ${v.label} (${v.protocol}): ${r.best.apy.toFixed(2)}%${r.best.apyNote ? ` (${r.best.apyNote})` : ""}, ≈ $${r.best.net.toFixed(2)} over 30 days after costs; exit: ${v.exit}`);
      const losers = r.options.filter((o) => o !== r.best).slice(0, 3);
      for (const o of losers) console.log(`    not ${o.venue.label}: ${o.excluded.length ? o.excluded.join("; ") : `$${o.net.toFixed(2)} over 30 days`}`);
      await prepare(adapterOf(v), "deposit", v, amount, asset);
    } else if ((m = /withdraw ([\d.]+) (\w+)(?: from (.+))?/.exec(t))) {
      const [amount, asset, from] = [Number(m[1]), m[2].toUpperCase(), m[3]];
      const held = (await Promise.all(adapters.map(async (a) => (await a.call("positions", user)) ?? []))).flat().filter((p) => p.asset === asset && (!from || p.label.toLowerCase().includes(from)));
      const vs = await venues(asset);
      if (notice()) console.log(notice());
      // Candidates: positions large enough, whose venue can pay out now. Prefer instant exits, then the lowest yield
      // (giving up the least).
      const cands = [];
      for (const p of held) {
        const v = vs.find((x) => x.id === p.venue);
        const reasons = [];
        if (p.amount < amount) reasons.push(`holds only ${fmt(p.amount)} ${asset}`);
        if (v.protocol === "Morpho Blue" && v.liquidity < amount) reasons.push(`market liquidity ${fmt(v.liquidity)} ${asset}`);
        // Instant only where it is verified: Morpho up to its liquidity; a vault only if it redeems synchronously and
        // holds the asset on chain.
        const instant = v.protocol === "Morpho Blue" || v.exitVerified;
        if (v.protocol === "Vaults" && v.raw.redemptionMode === "sync") {
          const mw = await adapterOf(v).call("maxWithdraw", user, v);
          if (mw != null && Number(mw) / 10 ** DEC[asset] < amount) reasons.push(`maxWithdraw is ${fmt(Number(mw) / 10 ** DEC[asset])} ${asset}`);
        }
        cands.push({ p, v, reasons, instant });
      }
      const ok = cands.filter((c) => !c.reasons.length).sort((a, b) => Number(b.instant) - Number(a.instant) || (a.p.apy ?? 0) - (b.p.apy ?? 0));
      for (const c of cands.filter((c) => c.reasons.length)) console.log(`    not ${c.v.label}: ${c.reasons.join("; ")}`);
      if (!ok.length) {
        console.log(`  nothing to route: ${held.length ? "no position can pay that out now" : `no ${asset} position found for ${user} in the protocols that answered`}`);
        continue;
      }
      const c = ok[0];
      console.log(`  route → ${c.v.label} (${c.v.protocol}): holds ${fmt(c.p.amount)} ${asset}, gives up ${c.p.apy?.toFixed(2) ?? "?"}%${ok.length > 1 ? ` — lower than ${ok.slice(1).map((o) => `${o.v.label} ${o.p.apy?.toFixed(2)}%`).join(", ")}` : ""}`);
      // No instant route: still prepare the only way out there is, and say plainly that it is not instant.
      if (!c.instant) console.log(`    ⚠ not an instant exit: ${c.v.exit}`);
      await prepare(adapterOf(c.v), "withdraw", c.v, amount, asset);
    } else {
      console.log("  I don't understand that request. I can do: rates for <token> · positions · deposit <amount> <token> · withdraw <amount> <token> [from <venue>]");
    }
  }

  /** Unsigned transactions from the venue's adapter; the first is simulated from the user. */
  async function prepare(a, action, v, amount, asset) {
    const raw = parseUnits(String(amount), DEC[asset]);
    const txs = await a.call(action, user, v, raw);
    if (!txs) return console.log(`  could not prepare: ${unavailable[a.key]}`);
    txs.forEach((x, i) => console.log(`    ${i + 1}. ${x.step}: to ${x.to}, data ${x.data.slice(0, 10)}… (${(x.data.length - 2) / 2} bytes) — unsigned`));
    const sim = await mcp.call("estimate_gas", { transaction: { from: user, to: txs[0].to, data: txs[0].data, value: toHex(0) } }).then(
      (g) => `simulates OK from ${user} (${g.gas ?? g} gas)`,
      (e) => `fails if sent now from ${user}: ${revertReason(e.message)}`,
    );
    console.log(`    step 1 ${sim}`);
  }
} finally {
  await mcp.close();
}
