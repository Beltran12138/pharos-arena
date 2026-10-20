// Shared settings for the x402 builds: Pharos Atlantic Testnet, Circle's test USDC, and the three test wallets
// (keys only in .env.atlantic, which is git-ignored; run with `node --env-file=.env.atlantic …`).
import { createPublicClient, defineChain, http } from "viem";

export const NETWORK = "eip155:688689";
export const ATLANTIC = defineChain({
  id: 688_689,
  name: "Pharos Atlantic Testnet",
  nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 },
  rpcUrls: { default: { http: ["https://atlantic.dplabs-internal.com"] } },
  blockExplorers: { default: { name: "PharosScan", url: "https://atlantic.pharosscan.xyz" } },
  testnet: true,
});
export const atlanticTx = (h) => `https://atlantic.pharosscan.xyz/tx/${h}`;

// Circle's test USDC (Token Registry, Atlantic): a FiatToken proxy whose implementation has EIP-3009
// transferWithAuthorization, EIP-712 name "USDC", version "2" — what the x402 "exact" scheme signs. The token the
// x402 Atlantic page names (0xE0BE…4ec8, "not an official address") has no EIP-3009 and no permit in its code,
// name "USD Coin" and no version(), so an x402 payment in it can't be settled (checked 2026-10-20, see README).
export const USDC = { address: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B", name: "USDC", version: "2", decimals: 6 };

export const PORTS = { facilitator: 4020, seller: 4021 };
export const atlantic = () => createPublicClient({ chain: ATLANTIC, transport: http(undefined, { timeout: 30_000, retryCount: 3 }) });

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run with --env-file=.env.atlantic)`);
  return v;
}

/** Price in USD → USDC base units, without float drift ("0.001" → 1000n). */
export function usdcUnits(price) {
  const [i, f = ""] = String(price).replace(/^\$/, "").split(".");
  if (f.length > USDC.decimals) throw new Error(`${price} has more than ${USDC.decimals} decimals`);
  return BigInt(i || "0") * 10n ** BigInt(USDC.decimals) + BigInt((f + "000000").slice(0, USDC.decimals));
}
