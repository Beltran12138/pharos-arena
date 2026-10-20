# Yield Optimizer

Compares every USDC and WPROS yield source it can read on Pharos mainnet — four tokenized vaults and the Morpho Blue
markets — with live on-chain rates, and recommends a move only when it beats staying put over a minimum holding
period after exit/entry fees and gas. A move comes out as unsigned transactions for the user to sign; the agent has
no key.

```bash
node yield-optimizer/optimize.mjs [requests.json]
```

## Sources and how each rate is read

| Source | Rate | Exit |
|---|---|---|
| Vaults (ERC-4626 / ERC-7575, [`lib/protocols.json`](../lib/protocols.json)) | share-price growth over 7 days, annualized (two agreeing reads at each block; 7 days is the longest history all four have) | `previewRedeem` for the fee; **redemption mode from the code that runs** (EIP-1967 implementation): `requestRedeem` present ⇒ ERC-7540 async queue |
| Morpho Blue markets lending USDC or WPROS | IRM borrow rate × utilization × (1 − fee), **after** adding the amount (a deposit lowers utilization, so the yield is diluted) | available liquidity = supplied − borrowed |

A vault's exit counts as verified only if redemption is synchronous **and** `previewRedeem` answers. Checking
`previewRedeem` alone was the first version's rule; reading the implementations showed the APT vault answers
`previewRedeem` and still routes exits through `requestRedeem`, so the rule was changed. On 2026-10-20:

| Vault | 7-day APY | Redemption |
|---|---|---|
| RPC-AKU vault `0xbf5b…177e` (impl `0xf2ad…fa15`) | 13.50% | sync, fee 0% → verified |
| VRPC-Aku `0xf441…93c6` (impl `0x8f14…30ad`) | 13.50% | async (ERC-7540) |
| APC3M `0xd042…908a` (impl `0x880a…`) | 12.92% (30-day: 12.98%) | async (ERC-7540) |
| APT vault `0x9219…ea6b` (impl `0x0d72…`) | 9.29% | async (ERC-7540), fee 0.15% |

## The decision ([`rank.mjs`](rank.mjs))

For each eligible venue: `net = amount × APY_new × days/365 − (exit fee now + entry fee + exit fee later + gas) −
amount × APY_current × days/365`. Move to the best if `net ≥ minGainUsd`; otherwise **stay put**, with the reason.
Also stay put if the current venue cannot pay the amount out now. Excluded, with the reason: unverified exits
(unless `allowUnverifiedExit`), venues without a readable rate, Morpho markets with almost no liquidity (money put
there could not come back out). On a tie, the verified exit wins.

## Demo on mainnet, 2026-10-20 ([`demo-run.txt`](demo-run.txt), [`requests.json`](requests.json))

17 sources at block 20,738,115; gas ≈ $0.0009 per transaction.

| Request | Result |
|---|---|
| A: 10,000 USDC idle in the wallet, hold 30 days | **move** to RPC-AKU vault: +$110.96 after costs ([`out/A-idle-usdc.json`](out/A-idle-usdc.json): approve, deposit) |
| B: 10,000 USDC in Morpho syzUSD/USDC (5.35%) | **move** to RPC-AKU vault: +$66.98 vs staying (withdraw, approve, deposit) |
| C: 1,000 USDC in Morpho wsrUSD/USDC, hold 7 days | **stay put**: best move gains $1.54, below the $5 minimum |
| D: 1,000,000 USDC in Morpho wsrUSD/USDC | **stay put**: only 586,860 USDC can be withdrawn now; also, adding 1M to syzUSD/USDC would dilute it from 5.35% to 4.14% |
| E: the real wallet's 0.0003 WPROS | **stay put**: the best WPROS rate earns less than the gas; the 3.66% WPROS market is excluded (0.05 WPROS of liquidity) |
| F: as A, but async exits accepted | **move** to RPC-AKU vault: same yield as VRPC-Aku, verified exit wins the tie |

Prepared transactions: the owner (`0x6Ea6…`) holds no USDC, so these are the plan for a holder. Step 1 of A
(approve) simulates; the output says the deposit would fail until the USDC is there. Step 1 of B (withdraw) reverts
from this wallet because it has no supply in that market. Nothing is signed or sent.

| Requirement | Where |
|---|---|
| ≥ 3 yield sources with live on-chain data | 17 (4 vaults, 13 Morpho markets) |
| Gas, entry/exit fees and a minimum holding period | `rank()` costs; `holdDays`; `minGainUsd` |
| Recommendation with expected net gain, or stay put with the reason | every request above |
| Prepared for signature only; no keys | `out/*.json` unsigned calldata; no key read anywhere |

Limits: the vault APYs come from 7 days of history; RPC-AKU redeems synchronously only while it has liquidity, which
is not readable in advance.

Tests: `npm test` (`test/yield.test.mjs`: net-gain arithmetic, minimum, exit fees, unverified exits and ties, Morpho
dilution and exit liquidity, dust).
