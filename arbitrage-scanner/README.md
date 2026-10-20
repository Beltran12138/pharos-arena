# Arbitrage Scanner

A Skill-style scanner that compares the WPROS price across every WPROS/USDC pool of the V3 factory on Pharos
mainnet (four fee tiers) and the Chainlink oracle, nets out both pools' fees, price impact, gas and a slippage
buffer, and acts — simulated, nothing is signed — only when the net profit clears a threshold. Every scan is logged.

```bash
node arbitrage-scanner/scan.mjs [--config config.json] [--every 60] [--for 600]
```

## Sources, read at one block per scan

| Source | Read |
|---|---|
| WPROS/USDC 0.01%, 0.05%, 0.3%, 1% pools (`getPool` on factory `0x2c90…552b`) | `slot0`, `liquidity` (two agreeing reads each), fee, tick spacing, the `tickBitmap` both ways, reserves — [`lib/v3.mjs`](../lib/v3.mjs) |
| Chainlink PROS/USD ÷ USDC/USD | `latestRoundData` at the same block (reference, not tradable) |
| gas | `get_gas_price` × 146,378 gas per swap — the median `gasUsed` of 12 real swap transactions on Pharos |

## For each pair of pools ([`arb.mjs`](arb.mjs))

Buy WPROS with USDC in the cheaper pool, sell it in the dearer one. Each leg is the V3 exact-input quote (it
reproduces real swaps to the wei, see `skill-chain-mcp-flow`), so both pools' fees and price impact are inside the
quote; a leg that would leave a pool's current liquidity range is not trusted. The size is searched (log grid, then
ternary search) for the highest net result:

`net = (USDC out − USDC in) − gas − slippage buffer (10 bps of size)`

and the log splits the gross result into ideal spread profit − fees − impact. Decision: act if `net ≥ minNetUsd`
(config, $0.50); otherwise skip, saying whether the spread is below the two fees or which cost ate it.

## Ten minutes on mainnet, 2026-10-20 ([`scan-run.txt`](scan-run.txt), log [`scans.jsonl`](scans.jsonl))

7 scans × 6 pool pairs = 42 decisions, all **skip**:

| Buy in → sell in | Gross spread seen | Fees (both pools) | Best net | Why skipped |
|---|---|---|---|---|
| 0.01% → 0.05% | 28–80 bps | 6 bps | −$0.0018 | the 0.05% pool has almost no liquidity in range |
| 0.3% → 0.01% | 1–32 bps | 31 bps | −$0.0018 | spread mostly below the fees |
| 1% → 0.01% | 40–92 bps | 101 bps | −$0.0018 | spread below the fees |
| 0.3% → 0.05% | 57–92 bps | 35 bps | −$0.0019 | thin 0.05% pool |
| 1% → 0.05% | 120 bps | 105 bps | −$0.0019 | both pools thin |
| 1% → 0.3% | 27–63 bps | 130 bps | −$0.0019 | spread below the fees |

**What it found**: the visible spreads are large (the 0.05% pool sits ~0.9% above the others), but a pool's price is
not its tradable depth. The 0.05% pool holds 11,484 USDC and 23,737 WPROS, yet the liquidity active at the current
price is 1.3·10¹² (the main pool: 8.0·10¹⁷): selling 0.1 WPROS into it already moves its price by 11%. The best
achievable gross is a fraction of a cent, below the $0.0018 gas. Gas on Pharos is cheap (10 gwei), so the binding
cost here is depth, not gas.

The act path is covered by tests with pools shaped like the main one and a 1% gap: the scanner acts, and its chosen
size is where the two pools' marginal prices meet after fees (checked independently); one size smaller or larger
makes less.

| Requirement | Where |
|---|---|
| Prices from ≥ 2 sources in the same scan | four pools + Chainlink, one block |
| Net profit after swap fees, slippage estimate and gas | `bestArb()`; the cost split in every log line |
| Acts only above a configurable threshold, else logs why | `decide()`, `minNetUsd` in `config.json` |
| Logs every scan with gross spread, costs, net and decision | `scans.jsonl` |
| Safe: simulated execution, no funds at risk | nothing is signed; the plan is printed when it would act |

Tests: `npm test` (`test/arbitrage.test.mjs`: acting on a real gap at the optimal size, fee-bound skip, thin-pool skip,
range guard).
