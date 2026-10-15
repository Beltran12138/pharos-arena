# Threshold Guardian

A Skill ([`SKILL.md`](SKILL.md)) that evaluates several on-chain conditions together and fires its action
only when **all** of them pass. Example from the task brief, implemented: *only rebalance if price moved
more than 3%, gas is below X, and the pool has more than Y liquidity*, plus two safety conditions (oracle
freshness, pool price agrees with the oracle).

```bash
node threshold-guardian/guardian.mjs threshold-guardian/configs/rebalance-after-move.json
```

Every condition is read through Chain MCP at one block: `get_gas_price`; `eth_call` on the Chainlink
PROS/USD feed (`latestRoundData`), on the WPROS/USDC V3 pool (`slot0`, `token0/1`) and on USDC
(`balanceOf`). Conditions and thresholds live in the config file (types listed in `SKILL.md`). Each run
prints and appends a decision trace to `trace.jsonl`: every condition's value, its rule, pass/fail, and
the final decision.

## Both outcomes, real mainnet runs

The two configs are identical except for the price of the last rebalance.

**Fires** ([`run-rebalance-after-move.txt`](run-rebalance-after-move.txt)), last rebalance at $0.58:

```
PROS/USDC rebalance guard (last rebalance at $0.58) — block 20,321,478 (2026-10-15T16:29:45.000Z), via Chain MCP
  PASS  price moved since last rebalance   PROS/USD 0.600290 vs reference 0.58 (+3.50%)   [|move| ≥ 3%]
  PASS  oracle is fresh                    PROS/USD updated 1354 s ago   [≤ 3600 s]
  PASS  pool agrees with oracle            pool 0.598176 vs oracle 0.600290 (-0.35%)   [|deviation| ≤ 1.5%]
  PASS  gas is cheap                       10 gwei   [≤ 20 gwei]
  PASS  pool has USDC liquidity            527,866.63 USDC in 0x912c…f647   [≥ 100,000 USDC]

Decision: FIRE → rebalance: swap back to the 50/50 PROS/USDC target through the WPROS/USDC pool
```

**Holds** ([`run-rebalance-no-move.txt`](run-rebalance-no-move.txt)), last rebalance at $0.60: the price
moved only +0.05%, the other four conditions pass, and the decision is
`HOLD (1 of 5 conditions failed: price moved since last rebalance). Nothing prepared.`

Both traces are in [`trace.jsonl`](trace.jsonl).

**Where the addresses come from.** PROS/USD feed: Pharos docs, *Chainlink Push Engine Feeds*
(`0x371E…5466`). Pool `0x912c…f647`: the WPROS/USDC 0.01% pool that emitted the `Swap` event of a real
PROS→USDC trade on mainnet; its price (0.598) checks against the oracle (0.600) within 0.4%.

| Requirement | Where |
|---|---|
| At least 3 independent conditions read from chain | 5: oracle move, oracle age, pool vs oracle, gas, liquidity |
| Configurable, not hard-coded | `configs/*.json`, six condition types |
| Decision trace each run: value, pass/fail, final decision | console output + `trace.jsonl` |
| One run that fires, one that holds | the two runs above |
