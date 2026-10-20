# Skill + Chain MCP Flow: Pharos Trade Timing

One request — *"sell 20000 WPROS for USDC"* — goes in; one decision — TRADE, SPLIT or WAIT, with the
minimum output to accept — comes out. The Skill ([`SKILL.md`](SKILL.md), rules in [`rules.json`](rules.json),
logic in [`decide.mjs`](decide.mjs)) makes the decision; Chain MCP supplies every number it decides on, read
in the same run. Follow-up commands come out in the official
[pharos-skill-engine](https://github.com/PharosNetwork/pharos-skill-engine) `cast` format, prepared for the
user to sign.

```bash
node skill-chain-mcp-flow/flow.mjs "sell 3 PROS for USDC" --wallet 0x… [--rules rules.json] [--trace trace.jsonl]
```

## What calls what, in order

```mermaid
sequenceDiagram
    actor U as User
    participant F as flow.mjs
    participant M as Chain MCP (mcp.pharos.xyz)
    participant S as Skill: pharos-trade-timing (decide.mjs + rules.json)
    U->>F: "sell 20000 WPROS for USDC"
    F->>F: parse → side, amount, token
    F->>M: get_block_number, get_block (pin one block, its time)
    F->>M: eth_call slot0, liquidity ×2 each (two agreeing reads), fee, tickSpacing
    F->>M: eth_call tickBitmap (walk toward the trade direction)
    F->>M: eth_call balanceOf(pool) for WPROS and USDC
    F->>M: eth_call Chainlink PROS/USD and USDC/USD latestRoundData
    F->>M: get_gas_price, get_balance / balanceOf(wallet)
    F->>S: decide(state, request, rules)
    S->>S: oracle fresh? pool vs oracle? balance+gas? depth?
    S->>S: V3 quote → impact, tick after; fits? else chunks
    S-->>F: TRADE / SPLIT / WAIT + checks + plan (minOut)
    F-->>U: decision, reasons with numbers, prepared cast commands
```

All chain reads are pinned to one block number, so the Skill sees one consistent state. The decision depends
on that state and on the rules: runs 1–3 differ in size, and run 4 is run 1 with stricter rules; they get
different answers.

## Demo runs on mainnet, 2026-10-20 ([`demo-run.txt`](demo-run.txt), trace [`trace.jsonl`](trace.jsonl))

| # | Request | Live data that decided it | Decision |
|---|---|---|---|
| 1 | sell 3 PROS, wallet 0x6Ea6… | pool 0.624 vs oracle 0.625; impact 0.01%; 4.99 PROS in the wallet | **TRADE**: expect 1.8661 USDC, min 1.8567 |
| 2 | sell 20,000 WPROS | impact 1.94% for the full size; 7 chunks at ≤0.3% each, price stays in range | **SPLIT**: 7 × 2,857 WPROS, min 1,763.37 USDC each |
| 3 | sell 120,000 WPROS | impact 10.6%; price would leave the scanned liquidity range | **WAIT** |
| 4 | request 1, stricter rules ([`rules-strict.json`](rules-strict.json), max 0.1% from the oracle) | pool 0.455% under the oracle | **WAIT** |

Each run makes 17–18 Chain MCP calls; `trace.jsonl` records every call (tool, arguments, time, result) and the
decision with its checks, one line per run.

## Why trust the numbers

- **Quote**: the Uniswap V3 exact-input formula inside one liquidity range. Replayed on 16 consecutive real
  swaps of this pool, it gives the chain's output amount and post-swap price to the wei
  (`test/skill-flow.test.mjs` keeps two of them).
- **Range**: the quote holds only until the price reaches the next initialized tick, so the flow reads the pool's
  `tickBitmap` in the trade's direction. A quote past it is not trusted (run 3), and past the last scanned word
  counts as "past it".
- **Pinned, agreeing reads**: `slot0` and `liquidity` are taken only when two reads agree; we measured the RPC
  returning wrong historical state in 2–5% of reads.
- **SPLIT is honest about what it buys**: in a constant-liquidity range, chunks sent back to back get the same total
  as one trade. The plan says to space them out and re-run the Skill before each one.

| Requirement | Where |
|---|---|
| The Skill's output depends on live data fetched via Chain MCP in the same flow | `flow.mjs` step 2 → `decide()`; runs 1–4 |
| Runs end to end from a single user request | `flow.mjs "<request>"` |
| Diagram / write-up of what calls what, in what order | the sequence diagram above |
| Demo run with real data moving through both tools | `demo-run.txt`, `trace.jsonl` |

Limits: only the WPROS/USDC 0.01% pool. The swap itself goes through whichever router the user uses (the main
router on Pharos is an aggregator whose calldata this Skill does not build), with the `amountOutMinimum` the Skill
gives. Foundry is not needed to run the flow; it is only needed to run the prepared `cast` commands.

Tests: `npm test` (`test/skill-flow.test.mjs`: quote vs real swaps, tick, TRADE/SPLIT/WAIT paths, oracle
direction, stale oracle, native gas reserve, range guard).
