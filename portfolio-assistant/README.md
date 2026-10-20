# Portfolio Assistant

Plain-language questions about a wallet's positions across its own balances, tokenized vaults and Morpho Blue
lending on Pharos mainnet — "what am I earning?", "where is my USDC?", "what's my biggest position?" — answered with
the contract and block behind every number. Read-only: no key, no transactions.

```bash
node portfolio-assistant/ask.mjs --wallet 0x… "what am I earning?" "where is my USDC?"
node portfolio-assistant/ask.mjs --wallet 0x…          # one question per line on stdin
```

## What it reads ([`snapshot.mjs`](snapshot.mjs), adapters in [`lib/protocols.mjs`](../lib/protocols.mjs))

One snapshot per run, at one block, through Chain MCP:

| Protocol | Positions | Rates | Price |
|---|---|---|---|
| Wallet | native PROS (`get_balance`), every known ERC-20 and vault share token (`balanceOf`) | – | Chainlink feeds |
| 4 USDC vaults (ERC-4626 / ERC-7575: APC3M, VRPC-Aku, APT, RPC-AKU) | shares held → `convertToAssets` | share-price growth over 7 days, annualized (two agreeing reads at each block) | share price × Chainlink USDC/USD |
| Morpho Blue, all 15 markets of `0x1857…4efb` | supply, borrow (interest accrued to the block's time), collateral | IRM `borrowRateView`; supply APY = borrow APY × utilization × (1 − fee) | vault-share collateral at the vault's share price; other collateral at the market's own oracle |

Health factor per borrow: collateral value × LLTV ÷ debt, as Morpho decides it.

## Questions it answers ([`answer.mjs`](answer.mjs))

| Type | Example |
|---|---|
| earning | what am I earning? → each position's rate and $/year, the net, and what earns nothing |
| where | where is my USDC? → wallet / vault / supplied / owed, with the net |
| balance | how much WPROS do I have? |
| biggest | what's my biggest position? |
| net worth | what's my net worth? → assets − debts, item by item; unpriced items listed, not counted |
| debt / risk | what do I owe? · am I at risk of liquidation? → health factor and the collateral drop to liquidation |

Anything it cannot read is said: a protocol it does not cover ("I can't read Uniswap … I won't guess"), a question it
does not understand (it lists what it can answer), a token it cannot price (left out of totals and named), a market
or vault that fails to read (named with the reason). "I don't see any WETH" comes with "that does not rule out WETH
elsewhere".

## Demo on mainnet, 2026-10-20 ([`demo-run.txt`](demo-run.txt))

Wallet `0x6776…1a2b`, a public address that runs a carry trade across two protocols. Snapshot at block 20,737,396:

- Morpho APC3M/USDC: 1,500,000.65 APC3M (shares of the APC3M vault) as collateral ≈ $1,547,194; borrowed
  1,004,414 USDC at 4.61%; health factor 1.3250.
- Morpho APT/USDC: 1,894,576.62 APT (shares of the APT vault) as collateral ≈ $1,906,612; borrowed 900,125 USDC at
  2.64%; health factor 1.8220.
- Wallet: 26.13 PROS, 223.01 WPROS.
- "What am I earning?": the collateral keeps earning its vaults' yield (12.92% and 9.27%) while the loans cost 4.61%
  and 2.64% → net ≈ $306,397/year at today's rates. Net worth ≈ $1,549,821.
- "What about my Uniswap LP?" → can't read it, won't guess. "Should I buy more?" → not a question it answers.

Cross-checks: the two debts match the liquidation watchdog's independent reading of the same positions
(1,004,406 USDC and 900,121 USDC an hour earlier, plus interest); collateral value = shares × share price × USDC/USD
(1,500,000.65 × 1.031679 × 0.99979 ≈ 1,547,194).

| Requirement | Where |
|---|---|
| Positions from ≥ 2 protocols or vaults, plus wallet balances | Morpho + vaults + wallet |
| ≥ 5 question types answered correctly | 7 types above; `test/portfolio.test.mjs` checks the arithmetic |
| Numbers with sources: contract and block | every answer line has `source:` lines |
| Says when it doesn't know or can't read | not covered / not understood / no price / unreadable |
| Read-only | no key is read; only `eth_call`, `get_balance`, `get_block` |

Limits: vault APYs are the last 7 days annualized and can move; APC3M and VRPC-Aku expose no `previewRedeem`, so
redemption terms are not readable here.
