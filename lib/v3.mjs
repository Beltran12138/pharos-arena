// Uniswap V3-style pool state at a pinned block, and its constant-liquidity range, through Chain MCP.
// The quote itself (quoteInRange, tickAt) is the one checked against real swaps in skill-chain-mcp-flow.
import { erc20Abi, parseAbi } from "viem";
import { read, readAgreed } from "./pharos.mjs";
export { quoteInRange, tickAt, priceOf } from "../skill-chain-mcp-flow/decide.mjs";

export const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/**
 * Nearest initialized tick from `tick` going down (sell token0) or up (buy token0), within `words` bitmap words.
 * If none, the edge of the scanned range: a quote is never trusted beyond what was looked at.
 */
export async function boundary(mcp, pool, tick, spacing, down, block, words = 2) {
  const word = Math.floor(tick / spacing) >> 8;
  for (let i = 0; i < words; i++) {
    const w = down ? word - i : word + i;
    const bits = await read(mcp, pool, POOL_ABI, "tickBitmap", [w], block);
    for (let k = 0; k < 256; k++) {
      const b = down ? 255 - k : k;
      const t = (w * 256 + b) * spacing;
      if ((down ? t > tick : t <= tick) || !((bits >> BigInt(b)) & 1n)) continue;
      return { tick: t, kind: "next initialized tick" };
    }
  }
  return { tick: (down ? (word - words + 1) * 256 : (word + words) * 256 - 1) * spacing, kind: `no initialized tick in ${words * 256} slots` };
}

/** Pool state that a decision can rest on: slot0 and liquidity from two agreeing reads, both range edges. */
export async function poolState(mcp, pool, block) {
  const [slot0, liquidity] = [await readAgreed(mcp, pool, POOL_ABI, "slot0", [], block), await readAgreed(mcp, pool, POOL_ABI, "liquidity", [], block)];
  const [fee, spacing, t0, t1] = [
    Number(await read(mcp, pool, POOL_ABI, "fee", [], block)),
    Number(await read(mcp, pool, POOL_ABI, "tickSpacing", [], block)),
    (await read(mcp, pool, POOL_ABI, "token0", [], block)).toLowerCase(),
    (await read(mcp, pool, POOL_ABI, "token1", [], block)).toLowerCase(),
  ];
  const tick = Number(slot0[1]);
  const [down, up] = [await boundary(mcp, pool, tick, spacing, true, block), await boundary(mcp, pool, tick, spacing, false, block)];
  const [r0, r1] = [await read(mcp, t0, erc20Abi, "balanceOf", [pool], block), await read(mcp, t1, erc20Abi, "balanceOf", [pool], block)];
  return { pool, block, sqrtPriceX96: slot0[0], tick, liquidity, feePpm: fee, spacing, token0: t0, token1: t1, reserve0: r0, reserve1: r1, lowTick: down.tick, highTick: up.tick, lowKind: down.kind, highKind: up.kind };
}
