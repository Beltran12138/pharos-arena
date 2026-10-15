// Uniswap V3-style pool reads through Chain MCP.
import { erc20Abi, parseAbi } from "viem";
import { TOKENS, read, readAgreed } from "./pharos.mjs";

const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);

// WPROS/USDC 0.01% pool used by the router behind most PROS↔USDC swaps on mainnet (found from a real
// swap's Swap event; factory 0x2c90CcB0b989afA2433F499698451a25744A552b).
export const WPROS_USDC_POOL = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";

/** Price of token0 in token1 (decimals applied), reserves held by the pool, fee in bps. */
export async function readPool(mcp, pool, block = "latest") {
  const [t0, t1, fee, slot0] = await Promise.all([
    read(mcp, pool, POOL_ABI, "token0", [], block),
    read(mcp, pool, POOL_ABI, "token1", [], block),
    read(mcp, pool, POOL_ABI, "fee", [], block),
    // The price decides things: at a pinned block, take it only when two reads agree (see readAgreed).
    block === "latest" ? read(mcp, pool, POOL_ABI, "slot0", [], block) : readAgreed(mcp, pool, POOL_ABI, "slot0", [], block),
  ]);
  const m0 = TOKENS[t0.toLowerCase()] ?? { symbol: t0, decimals: 18 };
  const m1 = TOKENS[t1.toLowerCase()] ?? { symbol: t1, decimals: 18 };
  const [bal0, bal1] = await Promise.all([
    read(mcp, t0, erc20Abi, "balanceOf", [pool], block),
    read(mcp, t1, erc20Abi, "balanceOf", [pool], block),
  ]);
  const sqrt = Number(slot0[0]) / 2 ** 96;
  const price = sqrt * sqrt * 10 ** (m0.decimals - m1.decimals);
  return {
    pool,
    token0: { address: t0.toLowerCase(), ...m0, reserve: bal0 },
    token1: { address: t1.toLowerCase(), ...m1, reserve: bal1 },
    feeBps: Number(fee) / 100,
    price, // token1 per token0
    tick: Number(slot0[1]),
  };
}
