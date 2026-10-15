---
name: pharos-threshold-guardian
description: >
  Use when an action on Pharos should only happen if several on-chain conditions hold at the same time
  (price moved enough, oracle fresh, pool price sane, gas cheap, enough liquidity). Reads every condition
  through Pharos Chain MCP, writes a decision trace, and prepares the action only when all pass.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Threshold Guardian

## How to use

```bash
node threshold-guardian/guardian.mjs <config.json> [--log trace.jsonl]
```

Exit code `0` = FIRE (all conditions passed, action prepared), `10` = HOLD, `1` = error. A condition that
cannot be read counts as failed (fail closed).

## Config

```json
{
  "name": "…",
  "conditions": [
    { "name": "price moved since last rebalance", "type": "feedMovePct", "pair": "PROS/USD", "reference": 0.58, "minPct": 3 },
    { "name": "oracle is fresh", "type": "feedAge", "pair": "PROS/USD", "maxSeconds": 3600 },
    { "name": "pool agrees with oracle", "type": "poolVsOracle", "pool": "0x…", "pair": "PROS/USD", "maxDeviationPct": 1.5 },
    { "name": "gas is cheap", "type": "gasPrice", "maxGwei": 20 },
    { "name": "pool has USDC liquidity", "type": "tokenBalance", "token": "0x…", "holder": "0x…", "min": 100000 }
  ],
  "action": { "description": "…", "request": { "…": "a request for dry-run-executor / policy-gatekeeper" } }
}
```

| Type | Reads | Passes when |
|---|---|---|
| `gasPrice` | `get_gas_price` | price ≤ `maxGwei` |
| `tokenBalance` | `eth_call balanceOf` | balance ≥ `min` |
| `feedAge` | Chainlink `latestRoundData` + block time | updated ≤ `maxSeconds` ago |
| `feedPrice` | Chainlink | `op` (`gt`/`gte`/`lt`/`lte`) `value` |
| `feedMovePct` | Chainlink | \|price − reference\| / reference ≥ `minPct` |
| `poolVsOracle` | V3 `slot0` + Chainlink | \|pool − oracle\| / oracle ≤ `maxDeviationPct` |

Feeds available: PROS/USD, USDC/USD, ETH/USD, BTC/USD, USDT/USD, LINK/USD (Chainlink self-managed feeds on
Pacific mainnet, 18 decimals).

## Rules for the agent

- On FIRE, the prepared request still goes through the dry-run executor and the policy gatekeeper before
  anything is signed. The guardian decides *whether*, not *how*.
- Do not lower thresholds in the config to make a HOLD become a FIRE. Thresholds are the owner's.
