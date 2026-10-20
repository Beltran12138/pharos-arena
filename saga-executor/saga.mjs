#!/usr/bin/env node
// Saga Executor (Pharos Agent Arena, Hard): wrap PROS → approve WPROS to Morpho → supply WPROS to a Morpho Blue
// market, each step verified on chain (receipt + the state change it should cause) before the next starts. Transient
// failures are retried (policy.mjs); a permanent failure undoes the verified steps in reverse: withdraw from Morpho,
// revoke the approval, unwrap. Every transition goes to a state log, so `status` shows exactly where a saga is.
//
//   node --env-file=.env saga-executor/saga.mjs run --amount 0.01 [--fail-at supply] [--drop-at approve] [--spike-at wrap]
//   node --env-file=.env saga-executor/saga.mjs rollback <saga-id>     undo every verified step (newest first)
//   node --env-file=.env saga-executor/saga.mjs resume <saga-id>       continue a paused or interrupted saga
//   node saga-executor/saga.mjs status <saga-id>                       where it is (no key needed)
//
// The owner runs it with their key; the key stays in this process. --fail-at / --drop-at / --spike-at inject a
// failure on purpose (logged as injected) to show the recovery paths.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, formatEther, getAddress, keccak256, parseAbi, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { CHAIN_ID, readAgreed, revertReason, txLink } from "../lib/pharos.mjs";
import { MORPHO } from "../lib/protocols.mjs";
import { POLICY, bumped, classify, compensationPlan, droppedDecision, fold, gasDecision } from "./policy.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const WPROS = getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0");
const MARKET = "0x6657f8b7ec9d900f8e975e3f7eb74b80e2783cbbacd1d3f90d144a3e34ad2faa"; // BTCVC/WPROS: 200k WPROS liquidity, so a supply can come straight back out
const WPROS_ABI = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);
const MORPHO_ABI = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const [cmd, idArg] = args;

// ── state log ──
mkdirSync(join(here, "state"), { recursive: true });
const logFile = (id) => join(here, "state", `${id}.jsonl`);
const readLog = (id) => readFileSync(logFile(id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
function logger(id) {
  return (e) => {
    const line = { t: new Date().toISOString(), saga: id, ...e };
    appendFileSync(logFile(id), JSON.stringify(line, (k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
    const where = e.step ? `${e.step.padEnd(8)} ${e.state.padEnd(12)}` : `${"saga".padEnd(8)} ${(e.phase ?? "").padEnd(12)}`;
    console.log(`  ${line.t.slice(11, 19)}  ${where} ${e.detail ?? ""}${e.tx ? ` ${txLink(e.tx)}` : ""}`);
  };
}

if (cmd === "status") {
  status(idArg);
} else {
  if (!["run", "rollback", "resume"].includes(cmd)) {
    console.error("usage: saga.mjs run --amount <PROS> [--fail-at supply] [--drop-at <step>] [--spike-at <step>] | rollback <id> | resume <id> | status <id>");
    process.exit(2);
  }
  if (!process.env.PRIVATE_KEY) throw new Error(`${cmd} needs PRIVATE_KEY (run with --env-file=.env)`);
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  const mcp = await connect();
  try {
    await main(mcp, account);
  } finally {
    await mcp.close();
  }
}

async function main(mcp, account) {
  const me = account.address;
  let id, start;
  if (cmd === "run") {
    id = `saga-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const head = Number((await mcp.call("get_block_number")).blockNumber);
    start = {
      amount: parseEther(opt("--amount", "0.01")),
      market: MARKET,
      baselineWpros: await readAgreed(mcp, WPROS, erc20Abi, "balanceOf", [me], head),
      inject: { failAt: opt("--fail-at", null), dropAt: opt("--drop-at", null), spikeAt: opt("--spike-at", null) },
      from: me,
    };
    console.log(`Saga ${id}: wrap ${formatEther(start.amount)} PROS → approve Morpho → supply to Morpho BTCVC/WPROS, from ${me}`);
    console.log(`  state log: saga-executor/state/${id}.jsonl\n`);
    logger(id)({ phase: "started", detail: `amount ${formatEther(start.amount)} PROS; WPROS already held ${formatEther(start.baselineWpros)} (kept out of the saga)${Object.values(start.inject).some(Boolean) ? `; injected: ${JSON.stringify(start.inject)}` : ""}`, start });
  } else {
    id = idArg;
    const first = readLog(id).find((e) => e.start);
    start = { ...first.start, amount: BigInt(first.start.amount), baselineWpros: BigInt(first.start.baselineWpros) };
    if (getAddress(start.from) !== me) throw new Error(`saga ${id} is for ${start.from}, this key is ${me}`);
    console.log(`Saga ${id} (${cmd}), from ${me}\n`);
  }
  const log = logger(id);
  const inject = cmd === "run" ? start.inject : {};
  const p = await mcp.call("eth_call", { transaction: { to: MORPHO, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "idToMarketParams", args: [start.market] }) } });
  const [loanToken, collateralToken, oracle, irm, lltv] = (await import("viem")).decodeFunctionResult({ abi: MORPHO_ABI, functionName: "idToMarketParams", data: p.result ?? p });
  const params = { loanToken, collateralToken, oracle, irm, lltv };
  const ctx = { mcp, account, me, start, params, inject, log };

  const def = steps(ctx);
  const byName = Object.fromEntries(def.map((s) => [s.name, s]));
  let state = fold(readLog(id));

  if (cmd === "rollback") {
    log({ phase: "compensating", detail: "rollback requested: undo every verified step, newest first" });
    return compensate(def, byName, ctx, id);
  }
  if (state.phase === "compensating") return compensate(def, byName, ctx, id);
  if (cmd === "resume") log({ phase: "running", detail: `resumed; step states: ${JSON.stringify(Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.state])))}` });

  for (const s of def.filter((x) => x.forward)) {
    state = fold(readLog(id));
    if (state.steps[s.name]?.state === "verified") continue;
    const r = await runStep(s, ctx, state.steps[s.name]);
    if (r === "verified") continue;
    if (r === "paused") {
      log({ phase: "paused", detail: `stopped at ${s.name} on a transient cause that outlasted the retries; nothing to undo yet — resume with: saga.mjs resume ${id}` });
      process.exitCode = 2;
      return;
    }
    log({ phase: "compensating", detail: `${s.name} failed permanently; undoing the verified steps` });
    return compensate(def, byName, ctx, id);
  }
  log({ phase: "completed", detail: `all ${def.filter((x) => x.forward).length} steps verified` });
}

async function compensate(def, byName, ctx, id) {
  const plan = compensationPlan(def.filter((x) => x.forward), fold(readLog(id)));
  if (!plan.length) ctx.log({ phase: "compensated", detail: "no verified step to undo" });
  for (const name of plan) {
    const r = await runStep(byName[name], ctx, fold(readLog(id)).steps[name]);
    if (r !== "verified") {
      // A compensation that cannot be done: stop and say exactly what is left where.
      ctx.log({ phase: "stuck", detail: `compensation ${name} did not complete (${r}); funds are where the last verified step left them — see status; resume with: saga.mjs resume ${id}` });
      process.exitCode = 1;
      return;
    }
  }
  if (plan.length) ctx.log({ phase: "compensated", detail: `undone: ${plan.join(", ")}` });
  process.exitCode = process.exitCode ?? (cmd === "rollback" ? 0 : 1);
}

/**
 * The saga's steps. Each: build() → { to, value, data } (built when the step starts, from current state);
 * check(rc) → the state change the step should have caused, read at the receipt's block against the block before.
 */
function steps({ mcp, me, start, params, inject }) {
  const at = (rc) => Number(BigInt(rc.blockNumber));
  const wpros = (b) => readAgreed(mcp, WPROS, erc20Abi, "balanceOf", [me], b);
  const allowance = (b) => readAgreed(mcp, WPROS, erc20Abi, "allowance", [me, MORPHO], b);
  const shares = async (b) => (await readAgreed(mcp, MORPHO, MORPHO_ABI, "position", [start.market, me], b))[0];
  const delta = async (f, rc) => (await f(at(rc))) - (await f(at(rc) - 1));
  const marketParams = inject.failAt === "supply" ? { ...params, lltv: params.lltv + 1n } : params; // injected: a market that doesn't exist
  return [
    {
      name: "wrap", forward: true, compensate: "unwrap",
      build: async () => ({ to: WPROS, value: start.amount, data: encodeFunctionData({ abi: WPROS_ABI, functionName: "deposit" }) }),
      check: async (rc) => { const d = await delta(wpros, rc); return { ok: d === start.amount, detail: `WPROS balance +${formatEther(d)} (expected +${formatEther(start.amount)})` }; },
    },
    {
      name: "approve", forward: true, compensate: "revoke",
      build: async () => ({ to: WPROS, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, start.amount] }) }),
      check: async (rc) => { const a = await allowance(at(rc)); return { ok: a === start.amount, detail: `allowance to Morpho ${formatEther(a)} WPROS` }; },
    },
    {
      name: "supply", forward: true, compensate: "withdraw",
      note: inject.failAt === "supply" ? "injected: market params with lltv + 1 (no such market)" : null,
      build: async () => ({ to: MORPHO, value: 0n, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supply", args: [marketParams, start.amount, 0n, me, "0x"] }) }),
      check: async (rc) => {
        const [dw, ds] = [await delta(wpros, rc), await delta(shares, rc)];
        return { ok: dw === -start.amount && ds > 0n, detail: `WPROS balance ${formatEther(dw)}, Morpho supply shares +${ds}` };
      },
    },
    // compensations
    {
      name: "withdraw",
      build: async () => ({ to: MORPHO, value: 0n, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdraw", args: [params, 0n, await shares(Number((await mcp.call("get_block_number")).blockNumber)), me, me] }) }),
      check: async (rc) => {
        const [dw, left] = [await delta(wpros, rc), await shares(at(rc))];
        return { ok: dw > 0n && left === 0n, detail: `WPROS balance +${formatEther(dw)} back from Morpho, supply shares left ${left}` };
      },
    },
    {
      name: "revoke",
      build: async () => ({ to: WPROS, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, 0n] }) }),
      check: async (rc) => { const a = await allowance(at(rc)); return { ok: a === 0n, detail: `allowance to Morpho ${formatEther(a)} WPROS` }; },
    },
    {
      name: "unwrap",
      // Only what the saga wrapped (less, if a Morpho withdrawal rounded down): WPROS held before the saga stays.
      build: async () => {
        const head = Number((await mcp.call("get_block_number")).blockNumber);
        const mine = (await wpros(head)) - start.baselineWpros;
        const wad = mine < start.amount ? mine : start.amount;
        if (wad <= 0n) throw new Error("execution reverted: nothing of the saga's WPROS left to unwrap");
        return { to: WPROS, value: 0n, data: encodeFunctionData({ abi: WPROS_ABI, functionName: "withdraw", args: [wad] }), wad };
      },
      check: async (rc) => { const d = await delta(wpros, rc); return { ok: d < 0n, detail: `WPROS balance ${formatEther(d)} (unwrapped to PROS)` }; },
    },
  ];
}

/** One step with the retry policy. Returns "verified" | "failed" | "paused". */
async function runStep(s, ctx, prior) {
  const { mcp, account, me, log, inject } = ctx;
  const L = (state, detail, extra = {}) => log({ step: s.name, state, detail, ...extra });
  const rpc = async (what, f) => {
    for (let i = 0; ; i++) {
      try {
        return await f();
      } catch (e) {
        if (classify(e) === "permanent" || i >= POLICY.rpcRetries) throw e;
        L("retrying", `${what}: ${e.message.split("\n")[0].slice(0, 90)} (transient, try ${i + 2} of ${POLICY.rpcRetries + 1})`);
        await sleep(POLICY.rpcBackoffMs * 2 ** i);
      }
    }
  };

  // Interrupted after sending (resume): find out what happened to that transaction before doing anything else.
  if (prior?.tx && ["sent", "signed", "confirmed"].includes(prior.state)) {
    const rc = await rpc("receipt", () => mcp.call("get_transaction_receipt", { hash: prior.tx })).catch(() => null);
    if (rc?.status === "0x1") return await verify(s, ctx, rc, L);
    const used = await rpc("nonce", () => nonce(mcp, me, "latest"));
    if (rc?.status === "0x0") { L("failed", `reverted on chain (found on resume)`, { tx: prior.tx }); return "failed"; }
    if (prior.nonce != null && used > prior.nonce) { L("failed", `nonce ${prior.nonce} was used by another transaction; this step did not execute`); return "failed"; }
    L("pending", `the earlier ${prior.tx.slice(0, 10)}… never landed (nonce ${prior.nonce} still free); starting the step again`);
  }

  L("pending", s.note ?? "");
  let tx;
  try {
    tx = await rpc("build", () => s.build());
  } catch (e) {
    L("failed", e.message.split("\n")[0]);
    return "failed";
  }
  // Simulate from the owner first: a revert here costs nothing and is permanent.
  let gas;
  try {
    const est = await rpc("estimate_gas", () => mcp.call("estimate_gas", { transaction: { from: me, to: tx.to, value: toHex(tx.value), data: tx.data } }));
    gas = (BigInt(est.gas ?? est.gasEstimate ?? est) * 12n) / 10n;
  } catch (e) {
    L("failed", `simulation reverts: ${revertReason(e.message)} — not sent, no gas spent`);
    return "failed";
  }
  L("simulated", `estimate_gas ok, gas limit ${gas}`);

  // Gas price: send at or below the cap, otherwise wait; pause if the spike lasts.
  let gasPrice;
  for (let waited = 0; ; waited++) {
    const real = BigInt((await rpc("gas price", () => mcp.call("get_gas_price"))).gasPriceWei);
    const seen = inject.spikeAt === s.name && waited < 2 ? 80n * 10n ** 9n : real; // injected: two readings of 80 gwei
    const d = gasDecision(seen, waited);
    if (d.action === "send") { gasPrice = real; break; }
    if (d.action === "pause") { L("paused", d.why); return "paused"; }
    const pauseMs = inject.spikeAt === s.name ? 3000 : POLICY.gasWaitMs; // an injected spike is waited out quickly
    L("retrying", `${d.why}${seen !== real ? " (injected spike)" : ""}; waiting ${pauseMs / 1000} s`);
    await sleep(pauseMs);
  }

  const n = await rpc("nonce", () => nonce(mcp, me, "pending"));
  const sign = (gp) => account.signTransaction({ chainId: CHAIN_ID, type: "legacy", to: tx.to, value: tx.value, data: tx.data, gas, gasPrice: gp, nonce: n });
  let raw = await sign(gasPrice);
  let hash = keccak256(raw);
  const hashes = [hash];
  L("signed", `nonce ${n}, gas price ${Number(gasPrice / 10n ** 9n)} gwei`, { tx: hash, nonce: n });

  const broadcast = async () => {
    try {
      await rpc("broadcast", () => mcp.call("send_raw_transaction", { rawTransaction: raw }));
    } catch (e) {
      if (/already known|known transaction/i.test(e.message)) return; // the node has it: fine
      throw e;
    }
  };
  if (inject.dropAt === s.name) L("sent", "injected: dropped — these bytes were NOT broadcast, as if the node had lost them", { tx: hash, nonce: n });
  else {
    try {
      await broadcast();
    } catch (e) {
      L("failed", `broadcast rejected: ${e.message.split("\n")[0].slice(0, 120)}`, { tx: hash });
      return "failed";
    }
    L("sent", "broadcast through Chain MCP", { tx: hash, nonce: n });
  }

  // Wait for the receipt; if it doesn't come, decide by policy.
  let rebroadcasts = 0, replacements = 0;
  for (;;) {
    const deadline = Date.now() + POLICY.receiptWaitMs;
    let rc = null;
    while (Date.now() < deadline) {
      for (const h of hashes) {
        rc = await mcp.call("get_transaction_receipt", { hash: h }).catch(() => null);
        if (rc?.status) { hash = h; break; }
        rc = null;
      }
      if (rc) break;
      await sleep(1500);
    }
    if (rc) {
      if (rc.status !== "0x1") { L("failed", `reverted on chain in block ${Number(BigInt(rc.blockNumber))} (gas spent)`, { tx: hash }); return "failed"; }
      L("confirmed", `block ${Number(BigInt(rc.blockNumber))}, gas used ${Number(BigInt(rc.gasUsed))}`, { tx: hash });
      return await verify(s, ctx, rc, L);
    }
    const known = (await mcp.call("get_transaction", { hash }).catch(() => null)) != null;
    const nonceUsed = (await rpc("nonce", () => nonce(mcp, me, "latest"))) > n;
    const d = droppedDecision({ known, nonceUsed, rebroadcasts, replacements });
    L("retrying", `no receipt after ${POLICY.receiptWaitMs / 1000} s: ${d.why}`, { tx: hash });
    if (d.action === "wait") continue;
    if (d.action === "pause") { L("paused", d.why); return "paused"; }
    if (d.action === "reconcile") {
      // One of our signed versions may have landed under another hash; otherwise the nonce went to something else.
      const found = (await Promise.all(hashes.map((h) => mcp.call("get_transaction_receipt", { hash: h }).catch(() => null)))).find((r) => r?.status);
      if (found) continue;
      L("failed", `nonce ${n} was taken by another transaction; this step did not execute`);
      return "failed";
    }
    if (d.action === "rebroadcast") rebroadcasts++;
    if (d.action === "replace") {
      replacements++;
      gasPrice = bumped(gasPrice, BigInt((await rpc("gas price", () => mcp.call("get_gas_price"))).gasPriceWei));
      raw = await sign(gasPrice);
      hash = keccak256(raw);
      hashes.push(hash);
      L("signed", `replacement: same nonce ${n}, gas price ${gasPrice} wei`, { tx: hash, nonce: n });
    }
    try {
      await broadcast();
    } catch (e) {
      if (classify(e) === "permanent") { L("failed", `broadcast rejected: ${e.message.split("\n")[0].slice(0, 120)}`); return "failed"; }
    }
    L("sent", d.action === "rebroadcast" ? "rebroadcast (same signed bytes)" : "replacement broadcast", { tx: hash, nonce: n });
  }
}

/** The receipt is not enough: check the state change the step was for. */
async function verify(s, ctx, rc, L) {
  let c;
  for (let i = 0; ; i++) {
    try {
      c = await s.check(rc);
      break;
    } catch (e) {
      if (classify(e) === "permanent" || i >= POLICY.rpcRetries) { L("failed", `could not read the result: ${e.message.split("\n")[0].slice(0, 100)}`); return "failed"; }
      await sleep(POLICY.rpcBackoffMs * 2 ** i);
    }
  }
  if (!c.ok) { L("failed", `receipt ok but the state is wrong: ${c.detail}`); return "failed"; }
  L("verified", c.detail);
  return "verified";
}

async function nonce(mcp, address, block) {
  const r = await mcp.call("get_transaction_count", { address, block });
  return Number(r.nonce ?? r.transactionCount ?? r.count ?? r);
}

function status(id) {
  if (!id || !existsSync(logFile(id))) throw new Error(`no saga log ${id}`);
  const entries = readLog(id);
  const st = fold(entries);
  const last = entries[entries.length - 1];
  console.log(`Saga ${id}: ${st.phase.toUpperCase()} (last change ${last.t})`);
  for (const [name, s] of Object.entries(st.steps)) console.log(`  ${name.padEnd(9)} ${s.state.padEnd(10)}${s.tx ? ` ${txLink(s.tx)}` : ""}`);
  if (st.failure) console.log(`  failure: ${st.failure.step}: ${st.failure.why}`);
  const now = Object.entries(st.steps).find(([, s]) => !["verified", "failed"].includes(s.state));
  console.log(`  now: ${now ? `${now[0]} is ${now[1].state}` : st.phase}`);
}
