---
name: pharos-batch-executor
description: >
  Use when the user wants to send PROS to several recipients at once on Pharos mainnet (payouts, refunds,
  tips, a payroll run) and asks to do it in one go or as cheaply as possible. Simulates every transfer on its
  own through the Pharos Chain MCP server, leaves out the ones that would fail (and says why), and bundles the
  rest into one Multicall3 aggregate3Value transaction that is all-or-nothing. Reports gas and steps saved
  against sending them one by one, and says when batching would cost more. Works with pharos-skill-engine:
  use that skill for single transfers and ERC-20 airdrops (its Distributor contracts).
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Batch Executor

## When to use

Three or more independent native PROS transfers from the same wallet. Not for ERC-20 tokens: sending the user's
tokens through Multicall3 would need an allowance to Multicall3, and anyone can call Multicall3, so never
approve it. For ERC-20 batches use pharos-skill-engine's airdrop flow (its own Distributor contract).

## How to use

1. Write the actions to a JSON file:

   ```json
   { "from": "0x…", "optimize": "gas",
     "actions": [ { "id": "salary", "to": "0x…", "value": "0.5" }, … ] }
   ```

   `value` is in PROS. `optimize` is `"gas"` (default: batch only if it is cheaper) or `"steps"` (batch to save
   signatures even if it costs a little more gas).

2. Plan (no key needed) and show the user the result:

   ```bash
   node batch-executor/batch.mjs plan actions.json
   ```

   Each action is listed `ok` or `FAIL` with the reason; failing ones are left out. Then the gas for the separate
   transfers against the batch, and the decision `BATCH` or `SEPARATE`.

3. If the user confirms (state that this is **mainnet** and the total), the user runs:

   ```bash
   node --env-file=.env batch-executor/batch.mjs exec actions.json
   ```

   It plans again on fresh state, sends one transaction, and reports each action as done (checked by the
   recipient's balance change in that block) or not executed.

## Partial failure

- Before sending: an action whose own simulation fails is left out and reported; the others still go.
- When sending: the batch uses `allowFailure = false`, so if anything fails on chain the whole transaction
  reverts, nothing moves, and every action is reported as not executed. With `allowFailure = true` a failed call's
  PROS would be left inside Multicall3, which is why this Skill never uses it.

## Cost

Measured on Pharos mainnet ([`scaling.txt`](scaling.txt)): about 36k gas of fixed overhead plus about 11.3k gas
per transfer, against 21k per separate transfer. Batching saves gas from 4 transfers up (6 → 17.5%, 12 → 32%);
for 2–3 transfers it costs more and only saves signatures.
