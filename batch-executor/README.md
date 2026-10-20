# Batch Executor

A Skill ([`SKILL.md`](SKILL.md)) that takes several independent native PROS transfers and sends them as one
Multicall3 `aggregate3Value` transaction on Pharos mainnet, instead of one transaction each.

```bash
node batch-executor/batch.mjs plan   actions.json             # simulate each, choose, estimate (no key)
node --env-file=.env batch-executor/batch.mjs exec actions.json
node batch-executor/batch.mjs verify actions.json <txHash>     # check a sent batch on chain (no key)
```

## How it works ([`batch.mjs`](batch.mjs))

1. Every action is simulated on its own (`estimate_gas` from the sender, through Chain MCP). One that would fail
   is **left out and reported with the reason**; the others go on.
2. The rest become one `aggregate3Value` call with `allowFailure = false`: all-or-nothing. If anything fails on
   chain, the transaction reverts and nothing moves. With `allowFailure = true` a failed call's PROS would stay in
   Multicall3 (it does not refund failed calls), free for anyone to take — the plan shows this with an `eth_call`.
3. **Decision**: batch only if it is cheaper in gas, or if the actions say `"optimize": "steps"`. Batching has
   fixed overhead; for 3 transfers it costs more ([`plan-small.txt`](plan-small.txt): `SEPARATE`).
4. After sending, each address's balance change in that block is compared with what its actions add up to (the
   sender: −total + what it sent to itself − fee), and each action is reported done / not executed / left out.

Only native transfers are batched: sending the user's ERC-20 tokens through Multicall3 would need an allowance to a
contract anyone can call. For token batches, use pharos-skill-engine's Distributor contracts.

## Run on mainnet, 2026-10-20

[`actions.json`](actions.json): six payouts (two to `0x6649…` — the sender's second wallet —, two to the burn
address, two back to the sender) plus one to the USDC token contract, which rejects PROS.

[`plan.txt`](plan.txt) → [`exec.txt`](exec.txt) → [`verify.txt`](verify.txt):

- `to-usdc` failed its own simulation and was left out; the six others were batched.
- Batch [`0xa57f…9720`](https://www.pharosscan.xyz/tx/0xa57f932d75c8fd7231e9da9c6d087dcd0a0c4eb6e6028500dba070965b8c9720),
  block 20,735,903: **81,681 gas** against 6 × 21,000 = **126,000** for separate transfers: **35.2% less gas and
  5 fewer transactions** (one signature, one nonce).
- Balance changes in that block: `0x6649…` +0.00003, burn address +0.00002, sender −0.00086681 (−0.00007 sent
  +0.00002 back −0.00081681 fee): all as expected, so all six actions are done.
- Receipt re-read from `rpc.pharos.xyz` directly: status 1, 81,681 gas, 10 gwei.

The first `exec` report marked four actions "unexpected": it compared each action with its recipient's whole
balance change, and two actions share each recipient; it also printed the sender's negative change without its
sign. The batch itself was correct. `verify` now groups by recipient, and the same transaction was re-checked
with it (`verify.txt`).

## Gas vs number of transfers ([`scaling.txt`](scaling.txt))

From `estimate_gas`: about 36k fixed + 11.3k per transfer against 21k per separate transfer, so batching pays from
4 transfers (6 → 17.5%, 12 → 32%). `estimate_gas` over-states this call: the plan estimated 103,951 for the six,
the chain charged 81,681. The real break-even is therefore at or below 4.

| Requirement | Where |
|---|---|
| A list of ≥ 3 independent actions | `actions.json` (7) |
| Executes them as a batch | one Multicall3 `aggregate3Value` transaction |
| Reports gas saving or step reduction vs individually | plan and exec reports; `runs.jsonl` |
| Handles partial failure clearly | pre-simulation leaves `to-usdc` out with its reason; all-or-nothing batch; per-action status |

No unit tests for this build: its checks run against the chain (`plan` simulates every action and the batch, `verify`
compares balance changes), and the run above is the test.
