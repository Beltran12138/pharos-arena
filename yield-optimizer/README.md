# Yield Optimizer

Compares every USDC and WPROS yield source it can read on Pharos mainnet — four tokenized vaults and the Morpho Blue
markets — with live on-chain rates, and recommends a move only when it beats staying put over a minimum holding
period after exit/entry fees and gas, into a venue whose exit can be verified on chain. A move comes out as unsigned
transactions for the user to sign; the agent has no key.

```bash
node yield-optimizer/optimize.mjs [requests.json]
```

## Sources and how each rate is read

| Source | Rate | Exit |
|---|---|---|
| Vaults (ERC-4626 / ERC-7575, [`lib/protocols.json`](../lib/protocols.json)) | share-price growth over 7 days, annualized (two agreeing reads at each block; 7 days is the longest history all four have) | redemption mode from the code that runs (EIP-1967 implementation: `requestRedeem` ⇒ ERC-7540 queue), `previewRedeem` fee, and **the asset the vault holds on chain** |
| Morpho Blue markets lending USDC or WPROS | IRM borrow rate × utilization × (1 − fee), **after** adding the amount (a deposit lowers utilization, so the yield is diluted) | available liquidity = supplied − borrowed |

A vault's exit counts as verified only if it redeems synchronously, answers `previewRedeem`, **and holds the asset
on chain**. The rule was tightened twice while building this, each time by a check on chain:

1. `previewRedeem` alone: the APT vault answers it, yet its implementation routes exits through `requestRedeem`.
2. sync code alone: the RPC-AKU vault's implementation has plain `withdraw`, but the vault holds 0 USDC, and a 1-unit
   `withdraw` simulated from its only holder (`0x0be2…94e7`, 4.99M shares) reverts with
   `AccessControlUnauthorizedAccount` — withdrawals are role-gated.

On 2026-10-20 none of the four vaults has a verifiable exit; they are real-world-asset vaults whose USDC is off
chain:

| Vault | 7-day APY | Redemption | USDC held on chain |
|---|---|---|---|
| RPC-AKU vault `0xbf5b…177e` (impl `0xf2ad…fa15`) | 13.50% | sync code, role-gated | 0 |
| VRPC-Aku `0xf441…93c6` (impl `0x8f14…30ad`) | 13.50% | async (ERC-7540) | 0 |
| APC3M `0xd042…908a` (impl `0x880a…75fc`) | 12.92% (30-day: 12.98%) | async (ERC-7540) | 0 |
| APT vault `0x9219…ea6b` (impl `0x0d72…6228`) | 9.29% | async (ERC-7540), fee 0.15% | 0 |

## The decision ([`rank.mjs`](rank.mjs))

For each eligible venue: `net = amount × APY_new × days/365 − (exit fee now + entry fee + exit fee later + gas) −
amount × APY_current × days/365`. Move to the best if `net ≥ minGainUsd`; otherwise **stay put**, with the reason.
Also stay put if the current venue cannot pay the amount out now. Excluded, with the reason: exits that cannot be
verified on chain (unless `allowUnverifiedExit`), venues without a readable rate, Morpho markets with almost no
liquidity (money put there could not come back out). On a tie, the verified exit wins.

## Demo on mainnet, 2026-10-20 ([`demo-run.txt`](demo-run.txt), [`requests.json`](requests.json))

17 sources at block 20,738,882; gas ≈ $0.0009 per transaction.

| Request | Result |
|---|---|
| A: 10,000 USDC idle in the wallet, hold 30 days | **move** to Morpho wsrUSD/USDC (5.45% after dilution): +$44.79 ([`out/A-idle-usdc.json`](out/A-idle-usdc.json): approve, supply) |
| B: 10,000 USDC in Morpho syzUSD/USDC (5.35%) | **stay put**: the best verified move (wsrUSD/USDC) gains $0.81 in 30 days, below the $5 minimum |
| C: 1,000 USDC in Morpho wsrUSD/USDC, hold 7 days | **stay put**: no move gains anything |
| D: 1,000,000 USDC in Morpho wsrUSD/USDC | **stay put**: only 586,860 USDC can be withdrawn now; also, adding 1M to syzUSD/USDC would dilute it from 5.35% to 4.14% |
| E: the real wallet's 0.0003 WPROS | **stay put**: the best WPROS rate earns less than the gas; the 3.66% WPROS market is excluded (0.05 WPROS of liquidity) |
| F: as A, but the user accepts unverifiable exits | **move** to VRPC-Aku: +$110.96, i.e. +$66 more than A for taking an exit that is a request queue ([`out/F-accept-unverified.json`](out/F-accept-unverified.json)) |

Prepared transactions: the owner (`0x6Ea6…`) holds no USDC, so these are the plan for a holder. Step 1 (approve)
simulates; the output says the deposit would fail until the USDC is there. Nothing is signed or sent. Check of A's
`supply` calldata outside the agent: its market parameters hash (`keccak256(abi.encode(params))`) to
`0xbea21c37…9e73`, the wsrUSD/USDC market id, so the transaction targets the market the agent chose.

| Requirement | Where |
|---|---|
| ≥ 3 yield sources with live on-chain data | 17 (4 vaults, 13 Morpho markets) |
| Gas, entry/exit fees and a minimum holding period | `rank()` costs; `holdDays`; `minGainUsd` |
| Recommendation with expected net gain, or stay put with the reason | every request above |
| Prepared for signature only; no keys | `out/*.json` unsigned calldata; no key read anywhere |

Limits: the vault APYs come from 7 days of history. Whether a vault would let *you* deposit (it may be role-gated,
like the RPC-AKU withdraw) is not checked: a deposit can only be simulated from an address that holds the USDC.

Tests: `npm test` (`test/yield.test.mjs`: net-gain arithmetic, minimum, exit fees, unverified exits and ties, Morpho
dilution and exit liquidity, dust).
