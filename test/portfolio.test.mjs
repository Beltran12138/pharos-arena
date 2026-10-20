import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, classify } from "../portfolio-assistant/answer.mjs";

const s = {
  wallet: "0xabc", block: 100, time: "2026-10-20T00:00:00Z", notCovered: ["Uniswap V3 LP positions"], unreadable: [{ what: "vault X", why: "reverted" }],
  rows: [
    { protocol: "wallet", what: "USDC in the wallet", asset: "USDC", amount: 500, usd: 500, apy: null, sources: ["USDC.balanceOf at block 100"] },
    { protocol: "vault", what: "Vault A: 1,000 SHA", asset: "USDC", amount: 1050, usd: 1050, apy: 10, sources: ["A.convertToAssets at block 100"] },
    { protocol: "morpho", what: "Morpho C/USDC: 2,000 C as collateral", asset: "C", amount: 2000, usd: 3000, apy: null, apyNote: "not readable", sources: ["Morpho.position at block 100"] },
    { protocol: "morpho", what: "Morpho C/USDC: borrowed USDC", asset: "USDC", amount: -1000, usd: -1000, apy: 5, debt: true, healthFactor: 2.58, lltv: 86, sources: ["Morpho.position at block 100"] },
    { protocol: "wallet", what: "ODD in the wallet", asset: "ODD", amount: 7, usd: null, apy: null, sources: ["ODD.balanceOf at block 100", "no price source for this token"] },
  ],
};

test("question types are recognised", () => {
  assert.deepEqual(
    ["what am I earning?", "where is my USDC?", "how much USDC do I have", "what's my biggest position?", "what's my net worth?", "what do I owe?", "am I at risk of liquidation?", "my uniswap LP?", "tell me a joke"].map((q) => classify(q).intent),
    ["earning", "where", "where", "biggest", "netWorth", "debt", "risk", "notCovered", "unknown"],
  );
});

test("numbers are computed from the snapshot only, and unpriced items are left out, not guessed", () => {
  const nw = answer("what's my net worth?", s);
  assert.match(nw, /Net worth ≈ \$3,550 .*assets \$4,550, debts −\$1,000/);
  assert.match(nw, /Not included \(no price\): ODD in the wallet/);
  assert.match(answer("what am I earning?", s), /Net, at today's rates: \$55\/year/); // 1050·10% − 1000·5%
  assert.match(answer("where is my USDC?", s), /Net USDC: 550/); // 500 + 1050 − 1000
  assert.match(answer("what's my biggest position?", s), /biggest position is Morpho C\/USDC: 2,000 C as collateral/);
});

test("every figure carries a source, and what could not be read is said", () => {
  const a = answer("where is my USDC?", s);
  assert.equal((a.match(/source:/g) ?? []).length, 3);
  assert.match(a, /Could not read: vault X \(reverted\)/);
  assert.match(answer("what about my uniswap lp?", s), /I can't read Uniswap.*won't guess/);
  assert.match(answer("where is my WETH?", s), /I don't see any WETH.*does not rule out/);
});

test("risk answer gives the health factor and the drop to liquidation", () => {
  assert.match(answer("am I at risk of liquidation?", s), /health factor 2\.5800.*comfortable; the collateral can fall 61\.2% before liquidation/);
});
