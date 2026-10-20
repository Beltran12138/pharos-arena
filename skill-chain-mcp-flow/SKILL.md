---
name: pharos-trade-timing
description: >
  Use when the user asks whether, when or how to sell PROS/WPROS for USDC (or USDC for WPROS) on Pharos
  mainnet, e.g. "should I sell 500 WPROS now?", "is the pool price fair?", "how should I swap 20k PROS?".
  Decides TRADE, SPLIT or WAIT from live chain state read through the Pharos Chain MCP server (pool price,
  liquidity and tick range, Chainlink PROS/USD and USDC/USD, gas, the user's balance) and returns the minimum
  output to accept. Works together with pharos-skill-engine: the follow-up commands it prepares are in that
  skill's cast format. It never signs.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Trade Timing

A decision Skill for the WPROS/USDC 0.01% pool on Pharos mainnet (chain 1672,
`0x912c9ade24d44d8922f0866d8dcb079f1363f647`). The decision is made by the rules in `rules.json`; every
number the rules look at comes from Chain MCP (`https://mcp.pharos.xyz/mcp`) in the same run.

## When to use

The user wants to swap between PROS/WPROS and USDC on Pharos and asks for an amount, or asks whether now is
a good time. Not for other pairs or for execution itself.

## How to use

1. Turn the user's request into one line and run the flow (one call does everything):

   ```bash
   node skill-chain-mcp-flow/flow.mjs "sell <amount> <PROS|WPROS|USDC>" [--wallet 0x…] [--trace trace.jsonl]
   ```

   Pass `--wallet` when you know the user's address, so balance and gas are checked too.

2. Read the decision line and the checks under it, and tell the user in plain words:

   | Decision | Meaning | What to tell the user |
   |---|---|---|
   | `TRADE` | every check passed for the full size | the expected output and the minimum to accept (`amountOutMinimum`) |
   | `SPLIT` | fair price, but the full size moves the pool more than `maxImpactPct` | the chunk size and count; space the chunks out and run this skill again before each one |
   | `WAIT` | a check failed that splitting cannot fix | which check failed and its numbers; nothing to sign |

3. If the decision is TRADE or SPLIT, show the prepared commands. They follow the pharos-skill-engine
   format (`cast send … --private-key $PRIVATE_KEY --rpc-url …`). Follow that skill's write pre-checks:
   tell the user the target is **mainnet** and get their confirmation before anything is signed. Re-check
   the price with the prepared `cast call … slot0()` just before signing.

## The rules (`rules.json`)

| Check | Fails when | Effect |
|---|---|---|
| oracle fresh | the Chainlink update is older than `maxOracleAgeSec` (heartbeat 3,600 s) | WAIT: nothing to compare the pool against |
| pool vs oracle | the pool price is worse than PROS/USD ÷ USDC/USD by more than `maxDeviationPct` for this side | WAIT |
| balance, gas reserve | the wallet lacks the amount, or what is left cannot pay gas + `gasReservePros` | WAIT |
| pool depth | the quote would take half of the output-side reserve | WAIT |
| liquidity range | the price would pass the next initialized tick (read from the pool's `tickBitmap`) | SPLIT if chunks fit, else WAIT |
| price impact | the full size costs more than `maxImpactPct` against the pool's spot price | SPLIT if chunks fit, else WAIT |

The quote is the Uniswap V3 exact-input formula inside one liquidity range; it reproduces 16 real swaps of
this pool to the wei. A gap in the user's favour (pool better than oracle) does not block.

## Never

- Never sign or send anything from this skill. Hand the prepared commands to the user.
- Never reuse a decision for a later chunk or a later time: run the flow again.
