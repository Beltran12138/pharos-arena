// Pharos mainnet constants, address labels and formatting shared by the builds.
import { decodeFunctionResult, encodeFunctionData, formatUnits } from "viem";

export const CHAIN_ID = 1672;
export const RPC_URL = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";
export const EXPLORER_API = "https://api.socialscan.io/pharos-mainnet/v1/explorer";
export const NATIVE = "PROS";

// From PharosNetwork/pharos-skill-engine assets/tokens.json (mainnet).
export const TOKENS = {
  "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0": { symbol: "WPROS", decimals: 18 },
  "0xc879c018db60520f4355c26ed1a6d572cdac1815": { symbol: "USDC", decimals: 6 },
  "0x51e2a24742db77604b881d6781ee16b5b8fcbe29": { symbol: "LINK", decimals: 18 },
  "0x1f4b7011ee3d53969bb67f59428a9ec0477856e9": { symbol: "WETH", decimals: 18 },
};

// Chainlink self-managed feeds on Pacific mainnet (docs.pharos.xyz → Oracles → Chainlink Push Engine Feeds).
// 18 decimals, 0.5% deviation, 3600 s heartbeat.
export const FEEDS = {
  "PROS/USD": "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466",
  "USDC/USD": "0x3f882C4F2836b1e5C5278ff2B9FccE2502A35C5d",
  "ETH/USD": "0x1Ed3e8CdC173363593BfAD9bF77aa2A0e7351DB8",
  "BTC/USD": "0x8b5DB228Fbccf588f08B073C235254aCb6791D36",
  "USDT/USD": "0x525D92D6Caa35060B4D5e3deDa6F52BdA3804618",
  "LINK/USD": "0x0644220E991a78Bf900648ce59211695cA47c480",
};
const FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: ["uint80", "int256", "uint256", "uint256", "uint80"].map((type) => ({ type })),
  },
];

/** Chainlink feed through Chain MCP: { price (number, USD), updatedAt (unix s), raw (bigint, 18 dec) }. */
export async function readFeed(mcp, pair, block = "latest") {
  const get = block === "latest" ? read : readAgreed;
  const [, answer, , updatedAt] = await get(mcp, FEEDS[pair], FEED_ABI, "latestRoundData", [], block);
  return { pair, address: FEEDS[pair], raw: answer, price: Number(answer) / 1e18, updatedAt: Number(updatedAt) };
}

export const LABELS = {
  "0x0000000000000000000000000000000000000000": "zero address",
  "0x000000000000000000000000000000000000dead": "burn address (0x…dEaD)",
  "0x7565f60988b83e577cb1a670ce577667311b11ae": "WPROS deployer",
  ...Object.fromEntries(Object.entries(TOKENS).map(([a, t]) => [a, `${t.symbol} token`])),
};

export const txLink = (hash) => `${EXPLORER}/tx/${hash}`;
export const addrLink = (a) => `${EXPLORER}/address/${a}`;
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const label = (a) => LABELS[a.toLowerCase()] ?? short(a);

/** Human number: grouped thousands, at most `dp` decimals, no trailing zeros. */
export function human(raw, decimals, dp = 6) {
  const s = formatUnits(BigInt(raw), decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  return BigInt(i).toLocaleString("en-US") + (frac ? `.${frac}` : "");
}

/** eth_call through Chain MCP and decode with viem. */
export async function read(mcp, address, abi, functionName, args = [], block = "latest") {
  const data = encodeFunctionData({ abi, functionName, args });
  const res = await mcp.call("eth_call", { transaction: { to: address, data }, block: String(block) });
  const hex = typeof res === "string" ? res : res.result ?? res.data;
  return decodeFunctionResult({ abi, functionName, data: hex });
}

/**
 * Same as read(), but asks up to `tries` times and returns the answer at least `need` reads agree on.
 * Measured on 2026-10-15: the same historical eth_call (pool slot0 at a fixed block) through Chain MCP returned
 * a different, wrong state in 4 of 80 reads, and through rpc.pharos.xyz directly in 1 of 40, so one read of a
 * value that drives a decision is not enough. Throws if no answer reaches `need`.
 */
export async function readAgreed(mcp, address, abi, functionName, args = [], block = "latest", { need = 2, tries = 5 } = {}) {
  if (block === "latest") throw new Error("readAgreed needs a pinned block number");
  const data = encodeFunctionData({ abi, functionName, args });
  const seen = new Map();
  for (let i = 0; i < tries; i++) {
    const res = await mcp.call("eth_call", { transaction: { to: address, data }, block: String(block) });
    const hex = typeof res === "string" ? res : res.result ?? res.data;
    seen.set(hex, (seen.get(hex) ?? 0) + 1);
    if (seen.get(hex) >= need) return decodeFunctionResult({ abi, functionName, data: hex });
  }
  throw new Error(`no ${need} matching answers in ${tries} reads of ${functionName} at block ${block} (${seen.size} different answers)`);
}
