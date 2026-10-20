#!/usr/bin/env node
// Reproduces inconsistent historical reads on Pharos mainnet: the same eth_call (WPROS/USDC pool slot0) at the
// same fixed block, repeated N times against an RPC endpoint. A consistent node answers identically every time.
//
//   node tools/rpc-consistency.mjs [--rpc https://rpc.pharos.xyz] [--block 20322745] [--n 100]
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const rpc = opt("--rpc", "https://rpc.pharos.xyz");
const block = Number(opt("--block", "20322745"));
const n = Number(opt("--n", "100"));
const POOL = "0x912c9ade24d44d8922f0866d8dcb079f1363f647"; // WPROS/USDC 0.01%
const SLOT0 = "0x3850c7bd";

const answers = new Map();
for (let i = 0; i < n; i++) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: POOL, data: SLOT0 }, "0x" + block.toString(16)] }),
    signal: AbortSignal.timeout(20000),
  }).then((x) => x.json()).catch((e) => ({ error: { message: e.message } }));
  const key = r.result ? r.result.slice(0, 66) : `error: ${r.error?.message}`;
  answers.set(key, (answers.get(key) ?? 0) + 1);
}
console.log(`${rpc}  eth_call slot0 on ${POOL} at block ${block}, ${n} times:`);
for (const [k, c] of [...answers].sort((a, b) => b[1] - a[1])) {
  const price = k.startsWith("0x") ? ((Number(BigInt(k)) / 2 ** 96) ** 2 * 1e12).toFixed(6) : "";
  console.log(`  ${String(c).padStart(4)}×  ${k.startsWith("0x") ? `sqrtPriceX96 ${BigInt(k)}  → ${price} USDC/PROS` : k}`);
}
if (answers.size > 1) process.exitCode = 1;
