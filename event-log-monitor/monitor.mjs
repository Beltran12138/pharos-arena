#!/usr/bin/env node
// Event/Log Monitor (Pharos Agent Arena, Easy): watch one Pharos contract for one event through Chain MCP
// get_logs, block by block, and print each new occurrence once, decoded.
//
//   node event-log-monitor/monitor.mjs [--contract 0x…] [--event "Transfer(address indexed from, address indexed to, uint256 value)"]
//                                      [--interval 3] [--from-block N] [--state file.json] [--for 120]
//
// Defaults: USDC on Pharos mainnet, Transfer. --for stops after N seconds (for demos); otherwise runs forever.
// The last processed block is saved to --state, so a restart resumes where it stopped without repeating events.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import { connect, MCP_URL } from "../lib/mcp.mjs";
import { TOKENS, human, label, txLink } from "../lib/pharos.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const contract = opt("--contract", "0xc879c018db60520f4355c26ed1a6d572cdac1815").toLowerCase();
const eventSig = opt("--event", "Transfer(address indexed from, address indexed to, uint256 value)");
const intervalMs = Number(opt("--interval", "3")) * 1000;
const statePath = opt("--state", null);
const stopAfter = opt("--for", null);
const MAX_RANGE = 1000; // Chain MCP get_logs limit

const event = parseAbiItem(`event ${eventSig}`);
const topic0 = toEventSelector(event);
const token = TOKENS[contract];
const seen = new Set(); // txHash:logIndex, guards against overlap between polls
const startedAt = Date.now();

const mcp = await connect();
const head = async () => Number((await mcp.call("get_block_number")).blockNumber);

let next = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).nextBlock : null;
next ??= Number(opt("--from-block", String(await head())));
console.log(`watching ${event.name} on ${label(contract)} (${contract}) from block ${next} via Chain MCP ${MCP_URL}`);
console.log(`topic0 ${topic0}\n`);

let count = 0;
try {
  for (;;) {
    const tip = await head();
    while (next <= tip) {
      const to = Math.min(tip, next + MAX_RANGE - 1);
      const logs = await mcp.call("get_logs", {
        address: contract,
        topics: [topic0],
        fromBlock: String(next),
        toBlock: String(to),
      });
      for (const log of Array.isArray(logs) ? logs : logs.logs ?? []) {
        const id = `${log.transactionHash}:${Number(BigInt(log.logIndex))}`;
        if (seen.has(id)) continue;
        seen.add(id);
        print(log);
        count++;
      }
      next = to + 1;
      if (statePath) writeFileSync(statePath, JSON.stringify({ contract, topic0, nextBlock: next }));
    }
    if (stopAfter && Date.now() - startedAt > Number(stopAfter) * 1000) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
} finally {
  await mcp.close();
}
console.log(`\nstopped at block ${next - 1}: ${count} event(s)`);

function print(log) {
  let fields;
  try {
    fields = decodeEventLog({ abi: [event], data: log.data, topics: log.topics }).args;
  } catch {
    fields = { raw: log.data };
  }
  const time = log.blockTimestamp ? new Date(Number(BigInt(log.blockTimestamp)) * 1000).toISOString().slice(11, 19) : "";
  const parts = Object.entries(fields).map(([k, v]) => {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return `${k}=${label(v)}`;
    if (typeof v === "bigint" && token) return `${k}=${human(v, token.decimals)} ${token.symbol}`;
    return `${k}=${v}`;
  });
  console.log(`[block ${Number(BigInt(log.blockNumber))} ${time}] ${event.name}  ${parts.join("  ")}`);
  console.log(`    log #${Number(BigInt(log.logIndex))}  ${txLink(log.transactionHash)}`);
}
