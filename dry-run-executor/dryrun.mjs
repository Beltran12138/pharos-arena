#!/usr/bin/env node
// Dry-Run Executor (Pharos Agent Arena, Medium): simulate a Pharos transaction before sending it.
// Predicts success or revert (with the reason), gas and fee, and the balance changes it will cause; blocks
// execution when the simulation fails.
//
//   node dry-run-executor/dryrun.mjs <request.json>             simulate only
//   node dry-run-executor/dryrun.mjs <request.json> --execute   simulate, then sign + send only if it passed
//
// request.json: { "from": "0x…", "to": "0x…", "value": "0.01", "call": { "fn": "transfer(address,uint256)", "args": [...] } }
// (or "data": "0x…" instead of "call"). --execute needs PRIVATE_KEY for `from` in the environment.
import { readFileSync } from "node:fs";
import { createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, erc20Abi, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../lib/mcp.mjs";
import { CHAIN_ID, NATIVE, RPC_URL, TOKENS, human, label, read, txLink } from "../lib/pharos.mjs";
import { parseRevert } from "../dapp-support-agent/diagnose.mjs";

const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const WPROS_ABI = parseAbi(["function deposit()", "function withdraw(uint256 wad)"]);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const execute = args.includes("--execute");
if (!file) {
  console.error("usage: dryrun.mjs <request.json> [--execute]");
  process.exit(2);
}
const req = JSON.parse(readFileSync(file, "utf8"));
const tx = {
  from: req.from.toLowerCase(),
  to: req.to.toLowerCase(),
  valueWei: req.valueWei ? BigInt(req.valueWei) : req.value ? parseEther(req.value) : 0n,
  data: req.data ?? "0x",
};
if (req.call) {
  const abi = parseAbi([`function ${req.call.fn}`]);
  tx.data = encodeFunctionData({ abi, functionName: abi[0].name, args: req.call.args ?? [] });
}

const mcp = await connect();
try {
  const sim = await simulate(mcp, tx);
  console.log(render(req, tx, sim));
  if (!sim.ok) {
    console.log(`\n⛔ BLOCKED: the simulation failed, so nothing was signed or sent.`);
    process.exitCode = 1;
  } else if (execute) {
    console.log(`\n→ simulation passed; executing`);
    console.log(await send(mcp, tx, sim));
  } else console.log(`\n✓ would succeed. Not sent (dry run). Add --execute to sign and send.`);
} finally {
  await mcp.close();
}

/** eth_call for success/revert, estimate_gas for gas, gas price for fee, balance reads before/after. */
async function simulate(mcp, tx) {
  const { blockNumber } = await mcp.call("get_block_number");
  const call = { from: tx.from, to: tx.to, value: "0x" + tx.valueWei.toString(16), data: tx.data };
  const out = { block: Number(blockNumber), ok: true };
  try {
    await mcp.call("eth_call", { transaction: call, block: blockNumber });
  } catch (e) {
    out.ok = false;
    out.revert = parseRevert(e.message);
  }
  if (out.ok) {
    try {
      out.gas = BigInt((await mcp.call("estimate_gas", { transaction: call })).gas);
    } catch (e) {
      out.ok = false;
      out.revert = parseRevert(e.message);
    }
  }
  const { gasPriceWei } = await mcp.call("get_gas_price");
  out.gasPrice = BigInt(gasPriceWei);
  out.fee = out.gas ? out.gas * out.gasPrice : null;
  out.changes = await predictChanges(mcp, tx, out, blockNumber);
  // A revert without a reason is often a balance the call would push below zero; say which one.
  const short = out.changes.find((c) => c.after < 0n && c.asset !== NATIVE);
  if (!out.ok && short && (!out.revert.raw || out.revert.kind === "unknown")) {
    out.revert.text += ` Most likely cause: it needs ${human(-short.delta, short.decimals)} ${short.asset} but ${label(short.who)} holds ${human(short.before, short.decimals)}.`;
  }
  // Can the sender pay value + fee at all?
  const nativeBefore = out.changes.find((c) => c.who === tx.from && c.asset === NATIVE)?.before;
  if (out.ok && nativeBefore !== undefined && nativeBefore < tx.valueWei + (out.fee ?? 0n)) {
    out.ok = false;
    out.revert = { text: `The sender holds ${human(nativeBefore, 18)} ${NATIVE}, less than the value plus fee.`, kind: "balance" };
  }
  return out;
}

/** Before/after for the balances this transaction touches, where its effect can be read from the calldata. */
async function predictChanges(mcp, tx, sim, block) {
  const rows = [];
  const native = async (who) => BigInt((await mcp.call("get_balance", { address: who, block })).balanceWei);
  const tokenBal = (token, who) => read(mcp, token, erc20Abi, "balanceOf", [who], block);
  const add = (who, asset, decimals, before, delta) => rows.push({ who, asset, decimals, before, after: before + delta, delta });

  const fee = sim.fee ?? 0n;
  let wrapped = null;
  if (tx.to === WPROS && tx.data !== "0x") {
    const { functionName, args } = decodeFunctionData({ abi: WPROS_ABI, data: tx.data });
    wrapped = functionName === "deposit" ? tx.valueWei : -args[0]; // WPROS delta for the sender
  }
  // Sender's PROS: minus value and fee, plus PROS returned by an unwrap.
  add(tx.from, NATIVE, 18, await native(tx.from), -tx.valueWei - fee + (wrapped !== null && wrapped < 0n ? -wrapped : 0n));
  if (tx.data === "0x" && tx.valueWei > 0n && tx.to !== tx.from) add(tx.to, NATIVE, 18, await native(tx.to), tx.valueWei);

  const token = TOKENS[tx.to];
  if (wrapped !== null) {
    add(tx.from, "WPROS", 18, await tokenBal(WPROS, tx.from), wrapped);
  } else if (token && tx.data !== "0x") {
    try {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (functionName === "transfer") {
        add(tx.from, token.symbol, token.decimals, await tokenBal(tx.to, tx.from), -args[1]);
        add(args[0].toLowerCase(), token.symbol, token.decimals, await tokenBal(tx.to, args[0]), args[1]);
      } else if (functionName === "approve") {
        const before = await read(mcp, tx.to, erc20Abi, "allowance", [tx.from, args[0]], block);
        rows.push({ who: tx.from, asset: `${token.symbol} allowance for ${label(args[0])}`, decimals: token.decimals, before, after: args[1], delta: args[1] - before });
      }
    } catch {
      // another function on the token; balances not predicted
    }
  }
  return rows;
}

function render(req, tx, sim) {
  const L = [];
  L.push(`Dry run at block ${sim.block.toLocaleString("en-US")} (Pharos mainnet, via Chain MCP)`);
  L.push(`  ${req.note ?? ""}`.trimEnd());
  L.push(`  from ${label(tx.from)}  to ${label(tx.to)}  value ${human(tx.valueWei, 18)} ${NATIVE}  data ${tx.data.length > 10 ? tx.data.slice(0, 10) + "…" : tx.data}`);
  L.push(``);
  if (sim.ok) {
    L.push(`Prediction: SUCCEEDS`);
    L.push(`  gas ${sim.gas.toLocaleString("en-US")} × ${human(sim.gasPrice, 9)} gwei = fee ${human(sim.fee, 18, 8)} ${NATIVE}`);
  } else {
    L.push(`Prediction: REVERTS`);
    L.push(`  reason: ${sim.revert.text}${sim.revert.raw ? `  (raw: ${sim.revert.raw})` : ""}`);
  }
  if (sim.changes.length) {
    L.push(``, `Balances ${sim.ok ? "before → after" : "now (unchanged, since it would revert)"}:`);
    for (const c of sim.changes) {
      const fmt = (v) => (v > 10n ** 70n ? "unlimited" : human(v, c.decimals, 8));
      L.push(`  ${label(c.who).padEnd(26)} ${c.asset.padEnd(28)} ${fmt(c.before)}${sim.ok ? ` → ${fmt(c.after)}  (${c.delta >= 0n ? "+" : "−"}${fmt(c.delta < 0n ? -c.delta : c.delta)})` : ""}`);
    }
  }
  return L.join("\n");
}

async function send(mcp, tx, sim) {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY ?? "0x");
  if (account.address.toLowerCase() !== tx.from) throw new Error(`PRIVATE_KEY is for ${account.address}, the request is from ${tx.from}`);
  const chain = defineChain({ id: CHAIN_ID, name: "Pharos", nativeCurrency: { name: NATIVE, symbol: NATIVE, decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({ to: tx.to, value: tx.valueWei, data: tx.data, gas: (sim.gas * 12n) / 10n });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await mcp.call("get_transaction_receipt", { hash });
      if (r?.status) {
        const used = BigInt(r.gasUsed);
        return `${r.status === "0x1" ? "✓ mined" : "✗ reverted"} in block ${Number(BigInt(r.blockNumber))}: gas used ${used} (predicted ${sim.gas}, ${((Number(used) / Number(sim.gas)) * 100).toFixed(1)}%)\n  ${txLink(hash)}`;
      }
    } catch {
      // not mined yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return `sent, not yet confirmed: ${txLink(hash)}`;
}
