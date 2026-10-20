// The Skill's decision: TRADE, SPLIT or WAIT for a WPROS↔USDC swap, from live pool and oracle state.
// Pure functions: the flow (flow.mjs) fetches the state through Chain MCP and passes it in.

const Q96 = 2n ** 96n;

/**
 * Exact-input swap inside the current tick range of a Uniswap V3-style pool (constant liquidity L).
 * Checked against 16 real swaps of the WPROS/USDC pool: predicted output equal to the wei.
 * side "sell0": amountIn of token0 → token1 out. side "buy0": amountIn of token1 → token0 out.
 */
export function quoteInRange({ sqrtPriceX96, liquidity, feePpm }, side, amountIn) {
  const S = BigInt(sqrtPriceX96), L = BigInt(liquidity);
  const net = (BigInt(amountIn) * (1_000_000n - BigInt(feePpm))) / 1_000_000n;
  if (side === "sell0") {
    // Rounded up, as the pool does (getNextSqrtPriceFromAmount0RoundingUp).
    const den = L * Q96 + net * S;
    const S2 = (L * S * Q96 + den - 1n) / den;
    return { amountOut: (L * (S - S2)) / Q96, sqrtAfter: S2 };
  }
  const S2 = S + (net * Q96) / L;
  return { amountOut: (L * Q96 * (S2 - S)) / (S * S2), sqrtAfter: S2 };
}

/** Tick at a sqrt price (Uniswap V3: price = 1.0001^tick). */
export const tickAt = (sqrtPriceX96) => Math.floor((2 * Math.log(Number(sqrtPriceX96) / 2 ** 96)) / Math.log(1.0001));

/** token1 per token0 with decimals applied. */
export const priceOf = (sqrtPriceX96, dec0, dec1) => (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1);

/**
 * state: { pool: { sqrtPriceX96, liquidity, feePpm, reserve1 }, oracle: { price, updatedAt }, now,
 *          gasPriceWei, balance: { in (bigint, token-in units) , pros (bigint wei) } | null,
 *          dec0, dec1 }
 * req:   { side: "sell0"|"buy0", amountIn (bigint, token-in units) }
 * rules: { maxOracleAgeSec, maxDeviationPct, maxImpactPct, slippagePct, gasReservePros, maxChunks }
 * Returns { decision, reasons[], checks[], plan }.
 */
export function decide(state, req, rules) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const { dec0, dec1 } = state;
  const decIn = req.side === "sell0" ? dec0 : dec1, decOut = req.side === "sell0" ? dec1 : dec0;
  const poolPrice = priceOf(state.pool.sqrtPriceX96, dec0, dec1);

  // 1. Can we trust the oracle we compare against?
  const age = state.now - state.oracle.updatedAt;
  check("oracle fresh", age <= rules.maxOracleAgeSec, `Chainlink PROS/USD updated ${age}s ago (limit ${rules.maxOracleAgeSec}s)`);

  // 2. Is the pool's price fair for this side? Selling token0 below the oracle (or buying above it) costs you.
  const devPct = (poolPrice / state.oracle.price - 1) * 100;
  const against = req.side === "sell0" ? -devPct : devPct; // > 0 means the pool is worse than the oracle for you
  check("pool vs oracle", against <= rules.maxDeviationPct,
    `pool ${poolPrice.toFixed(5)} vs oracle ${state.oracle.price.toFixed(5)} USD (${devPct >= 0 ? "+" : ""}${devPct.toFixed(3)}%; ` +
      `${against > 0 ? `${against.toFixed(3)}% against you` : "in your favour"}, limit ${rules.maxDeviationPct}%)`);

  // 3. Balance, if a wallet was given.
  if (state.balance) {
    check("balance", state.balance.in >= req.amountIn, `wallet holds ${fmt(state.balance.in, decIn)} of the ${fmt(req.amountIn, decIn)} to sell`);
    const gasCost = state.gasPriceWei * 300_000n;
    // Selling native PROS: what is left after the sale has to pay for gas.
    const left = state.balance.pros - (state.balance.native ? req.amountIn : 0n);
    check("gas reserve", left >= gasCost + BigInt(Math.round(rules.gasReservePros * 1e18)),
      `${fmt(left, 18)} PROS left for gas${state.balance.native ? " after the sale" : ""} (one swap ≈ ${fmt(gasCost, 18)} PROS at ${state.gasPriceWei} wei, reserve ${rules.gasReservePros})`);
  }

  // 4. Price impact of the whole size, and of chunks if needed.
  const impactOf = (amt) => {
    const q = quoteInRange(state.pool, req.side, amt);
    const spot = req.side === "sell0" ? (Number(amt) / 10 ** dec0) * poolPrice : (Number(amt) / 10 ** dec1) / poolPrice;
    const out = Number(q.amountOut) / 10 ** decOut;
    // The constant-liquidity quote holds only until the price reaches the next initialized tick.
    const after = tickAt(q.sqrtAfter);
    const inRange = req.side === "sell0" ? after > state.pool.boundaryTick : after < state.pool.boundaryTick;
    return { q, impactPct: (1 - out / spot) * 100, tickAfter: after, inRange };
  };
  const whole = impactOf(req.amountIn);
  const reserveOut = req.side === "sell0" ? state.pool.reserve1 : state.pool.reserve0;
  check("pool depth", whole.q.amountOut < BigInt(reserveOut) / 2n, `quote ${fmt(whole.q.amountOut, decOut)} out of a reserve of ${fmt(reserveOut, decOut)}`);

  check("liquidity range", whole.inRange,
    `price moves to tick ${whole.tickAfter}; constant liquidity holds to tick ${state.pool.boundaryTick} (${state.pool.boundaryKind})`);

  const fits = (x) => x.inRange && x.impactPct <= rules.maxImpactPct;
  let chunks = 1;
  let per = whole;
  while (!fits(per) && chunks < rules.maxChunks) {
    chunks++;
    per = impactOf(req.amountIn / BigInt(chunks));
  }
  check("price impact", whole.impactPct <= rules.maxImpactPct,
    `${whole.impactPct.toFixed(4)}% for the full size (limit ${rules.maxImpactPct}%, incl. ${Number(state.pool.feePpm) / 1e4}% fee)`);

  const blocking = checks.filter((c) => !c.ok && c.name !== "price impact" && c.name !== "liquidity range");
  const minOut = (amt) => (amt * BigInt(Math.round((1 - rules.slippagePct / 100) * 1e6))) / 1_000_000n;
  let decision, plan;
  if (blocking.length) {
    decision = "WAIT";
    plan = { why: blocking.map((c) => c.name) };
  } else if (fits(whole)) {
    decision = "TRADE";
    plan = { chunks: 1, amountIn: req.amountIn, expectedOut: whole.q.amountOut, minOut: minOut(whole.q.amountOut) };
  } else if (fits(per)) {
    decision = "SPLIT";
    const each = req.amountIn / BigInt(chunks);
    plan = { chunks, amountIn: each, expectedOut: per.q.amountOut, minOut: minOut(per.q.amountOut), impactPct: per.impactPct,
      // In a constant-liquidity range, chunks sent back to back get the same total as one trade: splitting
      // only helps if arbitrage brings the pool back to the oracle between chunks.
      note: "space the chunks out and re-run the skill before each one; back-to-back chunks get the same price as one big trade" };
  } else {
    decision = "WAIT";
    plan = { why: [`no chunk size up to ${chunks} chunks stays within ${rules.maxImpactPct}% impact and the liquidity range`] };
  }
  return { decision, poolPrice, impactPct: whole.impactPct, checks, plan };
}

export function fmt(raw, decimals, dp = 4) {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
}
