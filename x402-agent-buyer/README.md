# x402 Agent Buyer

An agent that pays for the data it uses. Its job: a **liquidation-risk report on Morpho Blue borrowers** on Pharos
mainnet. It buys the data from x402-paywalled APIs on Pharos Atlantic — the three paid routes of
[`x402-paywalled-api/`](../x402-paywalled-api/) — reading each price from the 402 itself, deciding what is worth
buying, paying within a budget and a per-call cap, and keeping a ledger that a retry can never double-count.

```bash
node --env-file=.env.atlantic x402-agent-buyer/agent.mjs --borrowers 0x…,0x… --budget 0.02 --cap 0.006 [--lose-response 2]
node --env-file=.env.atlantic x402-agent-buyer/reconcile.mjs --from-block <n>    # ledgers vs the chain
```

## How it decides ([`agent.mjs`](agent.mjs), [`budget.mjs`](budget.mjs))

1. **Plan** from the seller's free `/catalog`: per borrower `/v1/morpho/:address` ($0.005, **required**);
   `/v1/pros-price` ($0.001) and `/v1/pool/wpros-usdc` ($0.002) as **optional** context (oracle vs pool cross-check).
2. **Each purchase**: request → 402 → the price, asset, network and payee are read **from the 402** and checked
   against the catalog; then `canPay`: over the **per-call cap** → refused (the agent moves on); would push the
   total over the **budget** → the job **stops**, reporting what it has. Payments still in flight count as spent, so
   the budget holds even while an answer is pending.
3. **Worth it?** Required items first; optional ones only if a required one was not refused and the job did not stop —
   context for a report that can't be complete is not worth paying for.
4. **Ledger** ([`ledger/<job>.jsonl`](ledger/)): every payment by its **EIP-3009 nonce**, `in-flight → settled |
   not-settled`, with the price, the resource it bought, the tx hash and the running total.
5. **Safe retries**: a failed or lost answer is resolved by the chain, not by guessing —
   `USDC.authorizationState(buyer, nonce)`:
   - used → the payment went through: find its tx (`AuthorizationUsed` log), **count it once**; the data is still
     missing, so the item can be bought again as a *new* payment if the budget allows;
   - unused and the server refused the request itself (4xx other than 402) → nothing was paid, stop retrying;
   - unused otherwise → resend **the same signed payment** (same nonce: it can settle at most once), up to 3 times.
   A new signature (new nonce) is only ever made for a new purchase, never as a retry.
6. Every settlement is confirmed on chain by the agent: receipt + USDC `Transfer` buyer → payee of the price.

## Runs on Atlantic, 2026-10-20 ([`runs/`](runs/))

| Run | Job | What happened |
|---|---|---|
| [1](runs/1-complete-with-lost-response.txt) | 2 borrowers, budget $0.02, cap $0.006, **answer to the 2nd paid request dropped** (injected, after the server settled) | borrower 1 bought; borrower 2: answer lost → `authorizationState = true` → its tx [`0x1bf7ebf1…`](https://atlantic.pharosscan.xyz/tx/0x1bf7ebf1f183931437bd31aa7f286089818215bc1c67a0311a68cd7d85b2dac6) found and **counted once**; bought again (new nonce); then price and pool. 5 payments, **$0.018 of $0.02 → JOB DONE**. Report: `0xE6a4…` HF 1.0058 **CRITICAL** (liquidation if syzUSD falls 0.58%), `0xA4A5…` HF 1.0125 at risk; pool 0.15% above the oracle |
| [2](runs/2-stops-at-budget.txt) | 3 borrowers, budget $0.012 | the plan already says the budget can't cover all three; buys two ($0.01), the third would make $0.015 → **STOPPED at the budget**; optional items not bought |
| [3](runs/3-refuses-over-cap.txt) | 1 borrower, cap $0.004 | the borrower's data costs $0.005 → **refused over the cap**; the optional context is then not bought either: **$0 spent**, report incomplete |
| [4](runs/4-reconcile.txt) | reconcile | 22 USDC transfers from the buyer on chain; the 19 settled ledger payments each match one transfer, amount and payee, none twice (the two lost answers included); the other 3 are the paywalled API's own demo; $0.067 + $0.004 = $0.071, the on-chain total |

### What the runs turned up

- **The first run found a bug in the agent, and showed the system failing safe**
  ([`runs/0-before-fix-eip1191-checksum.txt`](runs/0-before-fix-eip1191-checksum.txt)). `borrowers.map(getAddress)`
  passes the array index as viem's `chainId` argument, so the second address got an EIP-1191 (chain 1) checksum.
  The seller rejected it with 400 *after* the payment had verified — and the middleware cancelled the settlement:
  the facilitator log shows three valid `/verify` and no `/settle`. The agent checked `authorizationState` (unused),
  resent the same payment, and counted nothing. Fixed (`map((a) => getAddress(a))`), and a 4xx other than 402 now
  stops the retries at once (nothing was paid; resending cannot help).
- **"Worth buying" needed a rule of its own.** In the first cap run (ledger `job-20261020T143636`) the agent refused
  the borrower's data and then bought the price and the pool anyway ($0.003 for a report with no borrower in it).
  Optional items are now skipped once a required one is missing.
- Superseded jobs are kept in `ledger/` and in the reconciliation: `…142944` (the bug run), `…143323` (first run 1),
  `…143547` / `…143636` (first runs 2 and 3, before the rule above).

| Requirement | Where |
|---|---|
| Calls at least 2 different x402 endpoints | three: `/v1/morpho/:address`, `/v1/pros-price`, `/v1/pool/wpros-usdc` |
| Spend budget and per-call price cap, refusing calls over either | `canPay`; run 2 (budget), run 3 (cap) |
| Logs every payment with price, what it bought, tx hash, running total | console lines + `ledger/*.jsonl`; `reconcile.mjs` against the chain |
| Retries that are safe: the same payment never counts twice | nonce-keyed ledger, `authorizationState`, resend only the same signed payment; run 1 + reconcile |
| A demo task that completes, and one that stops at the budget | runs 1 and 2 |

Tests: `npm test` (`test/x402.test.mjs`: cap vs budget, in-flight counted, a nonce counted once, buying order,
optional skipped when required data is missing, the retry decision).
