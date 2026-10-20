#!/usr/bin/env node
// x402 Paywalled API (Pharos Agent Arena, Medium). Sells Pharos *mainnet* data, read live through Chain MCP with
// the libraries the other builds use; payment is in test USDC on Atlantic Testnet, verified and settled by our own
// facilitator (facilitator.mjs).
//
//   free   GET /health · GET /catalog
//   $0.001 GET /v1/pros-price               PROS/USD from the Chainlink feed, with its age
//   $0.002 GET /v1/pool/wpros-usdc          WPROS/USDC 0.01% V3 pool: price, in-range liquidity, depth to the range edges
//   $0.005 GET /v1/morpho/:address          that address's Morpho Blue positions, health factor per borrow
//
//   node --env-file=.env.atlantic x402-paywalled-api/server.mjs
// A handler that fails answers 5xx and the payment is not settled (the middleware cancels it): no data, no charge.
import express from "express";
import { readFileSync } from "node:fs";
import { getAddress, isAddress, parseAbi } from "viem";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { connect } from "../lib/mcp.mjs";
import { readAgreed, readFeed } from "../lib/pharos.mjs";
import { MORPHO, morphoMarket } from "../lib/protocols.mjs";
import { WPROS_USDC_POOL } from "../lib/pool.mjs";
import { poolState, priceOf } from "../lib/v3.mjs";
import { NETWORK, PORTS, USDC, need, usdcUnits } from "./config.mjs";

const payTo = getAddress(need("SELLER_ADDRESS"));
const reg = JSON.parse(readFileSync(new URL("../lib/protocols.json", import.meta.url), "utf8"));
const POSITION_ABI = parseAbi(["function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"]);

export const ROUTES = {
  "GET /v1/pros-price": { price: "0.001", description: "PROS/USD from the Chainlink feed on Pharos mainnet, with the observation time" },
  "GET /v1/pool/wpros-usdc": { price: "0.002", description: "WPROS/USDC 0.01% pool on Pharos mainnet: price, in-range liquidity, the range edges" },
  "GET /v1/morpho/[address]": { price: "0.005", description: "Morpho Blue positions of an address on Pharos mainnet, with the health factor of each borrow" },
};

const scheme = new ExactEvmScheme();
// Prices are USD amounts; on Atlantic they are paid in Circle's test USDC (EIP-3009, name "USDC", version "2").
scheme.registerMoneyParser(async (amount, network) =>
  network === NETWORK ? { amount: usdcUnits(String(amount)).toString(), asset: USDC.address, extra: { token: USDC.name, name: USDC.name, version: USDC.version } } : null,
);
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: `http://localhost:${PORTS.facilitator}` })).register(NETWORK, scheme);

const mcp = await connect();
const app = express();
app.use(
  paymentMiddleware(
    Object.fromEntries(Object.entries(ROUTES).map(([route, r]) => [route, { accepts: { scheme: "exact", price: r.price, network: NETWORK, payTo }, description: r.description, mimeType: "application/json" }])),
    resourceServer,
  ),
);

const head = async () => {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  return { block, now };
};
const fail = (res, e) => res.status(502).json({ error: `mainnet read failed: ${e.message.split("\n")[0].slice(0, 160)}`, charged: false });

app.get("/health", (req, res) => res.json({ ok: true, network: NETWORK, payTo, asset: USDC.address, facilitator: `http://localhost:${PORTS.facilitator}` }));
app.get("/catalog", (req, res) => res.json({ network: NETWORK, asset: { ...USDC }, payTo, routes: Object.entries(ROUTES).map(([r, x]) => ({ route: r.replace("[address]", ":address"), priceUsd: x.price, description: x.description })), free: ["GET /health", "GET /catalog"] }));

app.get("/v1/pros-price", async (req, res) => {
  try {
    const { block, now } = await head();
    const f = await readFeed(mcp, "PROS/USD", block);
    res.json({ pair: "PROS/USD", price: f.price, updatedAt: new Date(f.updatedAt * 1000).toISOString(), ageSeconds: now - f.updatedAt, source: { chain: "Pharos mainnet (1672)", contract: f.address, call: "latestRoundData()", block } });
  } catch (e) {
    fail(res, e);
  }
});

app.get("/v1/pool/wpros-usdc", async (req, res) => {
  try {
    const { block } = await head();
    const s = await poolState(mcp, WPROS_USDC_POOL, block);
    // token0 = WPROS (18 decimals), token1 = USDC (6): price in USDC per WPROS
    const edge = (t) => priceOf(BigInt(Math.floor(Math.sqrt(1.0001 ** t) * 2 ** 96)), 18, 6);
    res.json({
      pool: WPROS_USDC_POOL, feePct: s.feePpm / 1e4, priceUsdcPerWpros: priceOf(s.sqrtPriceX96, 18, 6), tick: s.tick, inRangeLiquidity: String(s.liquidity),
      range: { low: { tick: s.lowTick, price: edge(s.lowTick), kind: s.lowKind }, high: { tick: s.highTick, price: edge(s.highTick), kind: s.highKind } },
      reserves: { WPROS: Number(s.reserve0) / 1e18, USDC: Number(s.reserve1) / 1e6 }, source: { chain: "Pharos mainnet (1672)", block },
    });
  } catch (e) {
    fail(res, e);
  }
});

app.get("/v1/morpho/:address", async (req, res) => {
  if (!isAddress(req.params.address)) return res.status(400).json({ error: "not an address", charged: false });
  try {
    const user = getAddress(req.params.address);
    const { block, now } = await head();
    const positions = [];
    // One position() read per market first; the full market (rates, oracle price, health factor) only where the
    // address has something — a full read of all 15 markets takes over a minute.
    // Two agreeing reads each (a wrong single read could hide a position), all markets at once.
    const pos = await Promise.all(reg.morphoMarkets.map((id) => readAgreed(mcp, MORPHO, POSITION_ABI, "position", [id, user], block)));
    const held = reg.morphoMarkets.filter((id, i) => pos[i].some((x) => x > 0n));
    for (const id of held) {
      const m = await morphoMarket(mcp, id, block, { user, now });
      const p = m.position;
      if (p && (p.supplied > 0 || p.borrowed > 0 || p.collateral > 0)) positions.push({ market: m.label, id, supplied: p.supplied, borrowed: p.borrowed, collateral: p.collateral, collateralValue: p.collateralValue ?? null, healthFactor: Number.isFinite(p.healthFactor) ? p.healthFactor : null, lltv: Number(m.params.lltv) / 1e18 });
    }
    res.json({ address: user, marketsChecked: reg.morphoMarkets.length, positions, source: { chain: "Pharos mainnet (1672)", contract: "Morpho Blue 0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb", block } });
  } catch (e) {
    fail(res, e);
  }
});

app.listen(PORTS.seller, () => console.log(`seller API on http://localhost:${PORTS.seller} — paid in ${NETWORK} USDC to ${payTo}; routes: ${Object.entries(ROUTES).map(([r, x]) => `${r} $${x.price}`).join(", ")}`));
