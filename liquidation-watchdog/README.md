# Liquidation Watchdog

Watches Morpho Blue borrow positions on Pharos mainnet (Morpho contract
[`0x1857…4efb`](https://www.pharosscan.xyz/address/0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb)) and alerts before
they reach liquidation, while there is still time to act. Every alert says what to do: repay X, or add Y of
collateral.

```bash
node liquidation-watchdog/watchdog.mjs discover                                   # find live borrow positions
node --env-file=.env liquidation-watchdog/watchdog.mjs check                     # one pass
node --env-file=.env liquidation-watchdog/watchdog.mjs watch [--interval 60]     # keep watching
#   --config positions.json   --console (no Telegram)   --for seconds
```

## What it reads (all through Chain MCP, one pinned block per pass)

| Value | Call |
|---|---|
| collateral, borrow shares of the position | `position(id, borrower)` |
| market totals and last interest update | `market(id)` |
| loan/collateral tokens, oracle, IRM, LLTV | `idToMarketParams(id)` |
| collateral price in loan-token units | the market oracle's `price()` (scale 1e36) |
| borrow rate | the IRM's `borrowRateView(marketParams, market)` |

Position, market and price are each taken only when two reads agree (we measured the RPC returning wrong
historical state in 2–5% of reads). Interest since the market's last update is added with Morpho's own
compounding (`wTaylorCompounded`), so the debt is what Morpho would charge right now, not the stored figure.

Health factor, as Morpho Blue decides it: `HF = collateral × price / 1e36 × LLTV / debt`; the position can be
liquidated when HF < 1.

## Thresholds and actions ([`positions.json`](positions.json))

- `defaults`: warn below 1.3, critical below 1.1, repair target 1.5. Per market (`markets`) or per position
  (`thresholds`) they can be changed. The two stablecoin-loop markets (syzUSD/USDC, wsrUSD/USDC, LLTV 91.5%) run at
  HF ≈ 1.02 by design, so they use warn 1.02 / critical 1.01 / target 1.03; with the defaults they would be
  critical forever and the alert would mean nothing.
- Each alert has: the level and HF, the thresholds, collateral (and its value at the market's oracle), debt with
  interest and the APR, how far the collateral price can fall before liquidation, and the action:
  `repay R loan tokens, or add C collateral, to get back to the target HF`.
- Alerts go to Telegram and the console with timestamps. A position alerts when it first appears in a non-ok
  level and on every change of level (worse, or recovered). Critical and liquidatable positions are reminded at
  most every `repeatCriticalHours` (6). Warn does not repeat. The state is saved, so restarts do not repeat alerts.

## Runs on mainnet, 2026-10-20

[`discover-run.txt`](discover-run.txt): 659 transactions touch the Morpho contract (its own transactions plus every
token transfer to or from it, from the explorer); their receipts, read through Chain MCP, give 33
market/borrower pairs, 24 with debt. The riskiest are stablecoin loops: about $9M borrowed at HF 1.006–1.033.

[`watch-run.txt`](watch-run.txt): 11 of those positions watched, alerts delivered to Telegram:

| Position | HF | Level | Suggested action |
|---|---|---|---|
| syzUSD loop A, debt 1,121,635 USDC | 1.0058 | critical (< 1.01) | repay 26,347 USDC or add 27,219 syzUSD → HF 1.03; liquidation if syzUSD −0.58% |
| syzUSD loop B, debt 1,335,316 USDC | 1.0125 | warn | repay 22,696 USDC or add 23,447 syzUSD |
| syzUSD loop C, debt 265,670 USDC | 1.0178 | warn | repay 3,155 USDC or add 3,260 syzUSD |
| wsrUSD loop A, debt 446,384 USDC | 1.0157 | warn | repay 6,205 USDC or add 6,327 wsrUSD |
| APC3M small, debt 1,661 USDC | 1.0685 | critical (< 1.1) | repay 478 USDC or add 808 APC3M → HF 1.5; liquidation if APC3M −6.41% |
| 6 others (APC3M 1M, APT 900k, WPROS 1M, …) | 1.02–2.75 | ok | – |

The second pass a minute later read all 11 again and sent nothing.

Cross-check of the riskiest position with raw JSON-RPC to `rpc.pharos.xyz` (no MCP): stored debt 1,121,629.70
USDC, max borrow 1,128,146.86, HF 1.00581. The watchdog's debt is 5.3 USDC higher: 44 minutes of interest at
5.76% APR since the market's last update (07:47), which is what the accrual is for.

| Requirement | Where |
|---|---|
| Reads collateral, debt and health factor from chain | `inspect()` in `watchdog.mjs`; `health()` in `morpho.mjs` |
| Configurable warning thresholds (e.g. 1.3 / 1.1) | `positions.json` defaults, per market, per position |
| Alerts through a channel (Telegram, console with timestamps) | `watch-run.txt`; Telegram bot @pharos_lighthouse_alerts_bot |
| A concrete action in each alert | `repairs()`: repay R or add C to reach the target |

These are other people's public positions, used because they are real and some are close to the line. To watch
your own, add `{ "market": "<id>", "borrower": "<your address>" }` to `positions.json` (`discover` lists the
market ids). Discovery sees positions whose transactions moved tokens through the Morpho contract, which is every
borrow and collateral deposit; it relies on the explorer's lists for the hashes.

Tests: `npm test` (`test/liquidation.test.mjs`: interest compounding, HF against a hand example, repay/add amounts
that land exactly on the target, threshold edges, alert repetition rules).
