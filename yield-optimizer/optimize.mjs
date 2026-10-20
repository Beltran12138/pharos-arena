#!/usr/bin/env node
// Yield Optimizer (Pharos Agent Arena, Hard): compare every USDC and WPROS yield source on Pharos mainnet that
// lib/protocols.json lists (tokenized vaults, Morpho Blue supply), with live on-chain rates, and recommend a move
// only when it beats staying put over a minimum holding period after fees and gas. A move is prepared as unsigned
// transactions for the user to sign; the agent holds no key.
//
//   node yield-optimizer/optimize.mjs requests.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseUnits } from "viem";
import { connect } from "../lib/mcp.mjs";
import { read, readFeed, revertReason } from "../lib/pharos.mjs";
import { MORPHO, morphoMarket, vault } from "../lib/protocols.mjs";
import { gasUsd, rank } from "./rank.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const reqs = JSON.parse(readFileSync(process.argv[2] ?? join(here, "requests.json"), "utf8"));
const reg = JSON.parse(readFileSync(new URL("../lib/protocols.json", import.meta.url), "utf8"));
const MORPHO_W = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const VAULT_W = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256)", "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)"]);
const DEC = { USDC: 6, WPROS: 18 };
const fmt = (x, dp = 2) => x.toLocaleString("en-US", { maximumFractionDigits: dp });

const mcp = await connect();
try {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  const prices = { USDC: (await readFeed(mcp, "USDC/USD", block)).price, WPROS: (await readFeed(mcp, "PROS/USD", block)).price };
  const { gasPriceWei } = await mcp.call("get_gas_price");
  const gas = { usdPerTx: gasUsd(150_000, gasPriceWei, prices.WPROS) };

  // Every source, normalized. Vault yield: 7-day share-price growth (the longest history all vaults have).
  const venues = [];
  for (const v of reg.vaults) {
    const x = await vault(mcp, v, block, { days: 7 });
    venues.push({ id: v.address, label: v.label, kind: "vault", asset: x.asset, apy: x.apy ?? null, apyBasis: x.apySource ?? x.apyUnknown,
      entryFeePct: x.entryFeePct ?? 0, exitFeePct: x.exitFeePct, exitVerified: x.exitVerified, exitNote: x.redemptionNote, raw: x });
  }
  for (const id of reg.morphoMarkets) {
    const m = await morphoMarket(mcp, id, block, { now });
    if (!["USDC", "WPROS"].includes(m.loan) || m.supplied === 0) continue;
    venues.push({ id, label: m.label, kind: "morpho", asset: m.loan, apy: m.supplyApy, apyBasis: `borrow ${m.borrowApy.toFixed(2)}% × utilization ${m.utilization.toFixed(1)}%`,
      entryFeePct: 0, exitFeePct: 0, exitVerified: true, liquidity: m.liquidity, raw: m });
  }
  console.log(`Block ${block} (${new Date(now * 1000).toISOString()}): ${venues.length} yield sources; gas ≈ $${gas.usdPerTx.toFixed(5)} per transaction\n`);
  for (const v of venues.sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1)))
    console.log(`  ${v.asset.padEnd(5)} ${(v.apy == null ? "  ?  " : v.apy.toFixed(2) + "%").padStart(7)}  ${v.label.padEnd(28)} ${v.kind === "morpho" ? `liquidity ${fmt(v.liquidity)} ${v.asset}` : `exit ${v.raw.redemptionMode}${v.exitFeePct != null ? `, fee ${fmt(v.exitFeePct, 3)}%` : ""}, ${fmt(v.raw.onHandAssets ?? 0)} ${v.asset} on hand${v.exitVerified ? "" : " (not verified)"}`}  (${v.apyBasis})`);

  mkdirSync(join(here, "out"), { recursive: true });
  for (const req of reqs) {
    const r = rank(venues, { ...req, assetUsd: prices[req.asset] }, gas);
    console.log(`\n════ ${req.id}: ${fmt(req.amount, 6)} ${req.asset} ${req.current === "wallet" ? "in the wallet" : `in ${venues.find((v) => v.id === req.current)?.label}`}, hold ≥ ${req.holdDays} days, move only if ≥ $${req.minGainUsd}`);
    console.log(`  staying: ${r.stay.apy.toFixed(2)}% → $${r.stay.gainUsd.toFixed(2)} over the period`);
    for (const o of r.options.slice(0, 6))
      console.log(`  ${o.excluded.length ? "excl " : "     "}${o.venue.label.padEnd(28)} ${o.apy == null ? "?" : o.apy.toFixed(2) + "%"}${o.apyNote ? ` (${o.apyNote})` : ""}` +
        (o.excluded.length ? ` — ${o.excluded.join("; ")}` : ` → gross $${o.gross.toFixed(2)}, costs $${o.cost.toFixed(2)} (exit now $${o.costs.exitCurrent.toFixed(2)}, entry $${o.costs.entryFee.toFixed(2)}, exit later $${o.costs.exitNewLater.toFixed(2)}, gas $${o.costs.gas.toFixed(4)}), net vs staying $${o.net.toFixed(2)}`));
    console.log(`  → ${r.decision === "move" ? "MOVE" : "STAY PUT"}: ${r.why}`);
    if (r.decision === "move") await prepareMove(req, r);
  }
} finally {
  await mcp.close();
}

/**
 * Unsigned transactions for the move, in order: leave the current venue, approve, enter the new one. Nothing is
 * signed. The first one is simulated from the owner; the later ones depend on it, so they cannot be simulated yet.
 */
async function prepareMove(req, r) {
  const raw = parseUnits(String(req.amount), DEC[req.asset]);
  const token = req.asset === "USDC" ? "0xc879c018db60520f4355c26ed1a6d572cdac1815" : "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
  const addr = getAddress(req.owner);
  const txs = [];
  const params = (v) => v.raw.params;
  if (r.current) {
    txs.push(r.current.kind === "morpho"
      ? { step: `withdraw ${req.amount} ${req.asset} from ${r.current.label}`, to: MORPHO, data: encodeFunctionData({ abi: MORPHO_W, functionName: "withdraw", args: [params(r.current), raw, 0n, addr, addr] }) }
      : { step: `withdraw ${req.amount} ${req.asset} from ${r.current.label}`, to: r.current.id, data: encodeFunctionData({ abi: VAULT_W, functionName: "withdraw", args: [raw, addr, addr] }) });
  }
  const target = r.best.venue;
  const spender = target.kind === "morpho" ? MORPHO : target.id;
  txs.push({ step: `approve ${req.amount} ${req.asset} to ${target.label}`, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), raw] }) });
  txs.push(target.kind === "morpho"
    ? { step: `supply ${req.amount} ${req.asset} to ${target.label}`, to: MORPHO, data: encodeFunctionData({ abi: MORPHO_W, functionName: "supply", args: [params(target), raw, 0n, addr, "0x"] }) }
    : { step: `deposit ${req.amount} ${req.asset} into ${target.label}`, to: target.id, data: encodeFunctionData({ abi: VAULT_W, functionName: "deposit", args: [raw, addr] }) });
  const sim = await mcp.call("estimate_gas", { transaction: { from: addr, to: txs[0].to, data: txs[0].data, value: "0x0" } }).then(
    (g) => `simulates OK from ${addr} (${g.gas ?? g} gas)`,
    (e) => `would fail if sent now from ${addr}: ${revertReason(e.message)}`,
  );
  // The later steps need the owner to actually hold the funds; say whether they do.
  const held = r.current ? null : await read(mcp, token, erc20Abi, "balanceOf", [addr]);
  const holds = held == null ? "" : held >= raw ? `; the owner holds the ${req.asset}` : `; the owner holds ${Number(held) / 10 ** DEC[req.asset]} ${req.asset}, so the deposit would fail until ${req.amount} is there — this is the plan for whoever holds it`;
  const file = join("out", `${req.id}.json`);
  writeFileSync(join(here, file), JSON.stringify({ request: req, decision: r.why, from: addr, chainId: 1672, firstStepSimulation: sim + holds, transactions: txs.map((t) => ({ ...t, value: "0" })) }, null, 1));
  console.log(`  prepared for ${addr} to sign, in order (${file}):`);
  txs.forEach((t, i) => console.log(`    ${i + 1}. ${t.step}: to ${t.to}, data ${t.data.slice(0, 10)}… (${(t.data.length - 2) / 2} bytes)`));
  console.log(`    step 1 ${sim}${holds}`);
}
