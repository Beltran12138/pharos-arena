# Audit-Log Agent

A plain-language activity report for one Pharos wallet over a date range, written for a compliance officer
or an accountant.

```bash
node audit-log-agent/report.mjs --wallet 0x… --from 2026-08-01 --to 2026-10-15 [--out dir] [--max 400]
```

Writes `report-<wallet>-<from>-<to>.md` and `.csv`.

**Sample:** the WPROS deployer wallet, 2026-08-01 to 2026-10-15:
[`sample/…md`](sample/report-0x7565f6-2026-08-01-2026-10-15.md),
[`sample/…csv`](sample/report-0x7565f6-2026-08-01-2026-10-15.csv).

## How it works

1. **Find the transactions.** The Pharos explorer API lists transactions and token transfers that touch the
   wallet; the agent keeps those inside the date range.
2. **Read the facts through Chain MCP.** For every hash: `get_transaction` (sender, recipient, value,
   calldata, timestamp) and `get_transaction_receipt` (status, gas, logs). Unknown tokens: `symbol` and
   `decimals` via `eth_call`.
3. **Classify from the raw logs**, not from explorer labels:
   - ERC-20 `Transfer` events to/from the wallet and native value give net flows per asset;
   - `Approval` events with the wallet as owner are approvals (unlimited ones are flagged);
   - a transaction in which the wallet gave up one asset and received another is a **swap** (a Uniswap
     V2/V3 `Swap` event, if present, names the venue);
   - only outflows → **transfer out**; inflows from someone else's transaction → **transfer in**;
     anything else the wallet sent → **contract interaction**; reverted → **failed**.
4. **Write the report:** a summary paragraph, totals per category and asset, notable transactions
   (unlimited approvals, failures, contract deployments, the largest inflow and outflow per asset) with
   explorer links, and every transaction in a table. The CSV has one row per asset movement.

Checked against a wallet with DeFi activity: a 100 PROS → 60.12 USDC trade was classified as a swap
(Uniswap V3-style) and three USDC approvals as approvals. That rate (0.601 USD/PROS) matches the market
price at the time, an independent check on the decimals handling.

| Requirement | Where |
|---|---|
| Wallet address and date range in | `--wallet`, `--from`, `--to` |
| Categories: transfers in/out, swaps, approvals, contract interactions | step 3 above; "Totals by category" |
| Totals per category; notable transactions with links | "Totals by category", "Notable transactions" |
| Export as Markdown, PDF or CSV | Markdown and CSV |

**Not covered:** PROS received through internal calls (other than WPROS unwraps) is not seen, because it
leaves no log; NFT transfers are skipped. Transaction discovery depends on the explorer API; everything after
discovery comes from Chain MCP.
