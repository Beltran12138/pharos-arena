---
name: pharos-saga-executor
description: >
  Use when the user wants to put native PROS to work in Morpho Blue on Pharos mainnet in one go — wrap PROS to
  WPROS, approve Morpho, supply to a WPROS market — or to undo such a position. Runs the steps as a saga: each one is
  simulated, signed, sent through the Pharos Chain MCP server and verified on chain (receipt and the balance /
  allowance / position change it should cause) before the next starts. Retries transient failures (gas spike, dropped
  transaction, RPC errors) and, on a permanent failure, undoes the verified steps in reverse (withdraw, revoke,
  unwrap). Every transition is written to a state log. Works with pharos-skill-engine: use that for single transfers.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Saga Executor

## When to use

The user asks to supply PROS to Morpho (it must be wrapped and approved first), or to take such a supply back out to
native PROS. Not for other protocols: the steps and their checks are written for WPROS and Morpho Blue.

## How to use

1. Tell the user what will happen, on **mainnet**: wrap `<amount>` PROS, approve exactly that amount to Morpho Blue
   `0x1857…4efb`, supply it to the BTCVC/WPROS market (≈ 200k WPROS liquidity, so it can be withdrawn at once).
   Three transactions, ≈ 0.002 PROS of gas.
2. The user runs it with their key (the key stays in their process):

   ```bash
   node --env-file=.env saga-executor/saga.mjs run --amount 0.01
   ```

   Each line is a transition: `pending → simulated → signed → sent → confirmed → verified`, with the transaction
   link. It ends `completed`, `compensated` (a step failed and the earlier ones were undone), `paused` or `stuck`.
3. Where is it? (no key needed)

   ```bash
   node saga-executor/saga.mjs status <saga-id>
   ```

4. To take the position back out later: `node --env-file=.env saga-executor/saga.mjs rollback <saga-id>` (withdraw
   all of the saga's Morpho shares, revoke, unwrap what the saga wrapped).
5. After `paused` (or if the process was interrupted): `… saga.mjs resume <saga-id>`. A step that was already sent
   is looked up first (receipt by hash, then the nonce), so nothing is sent twice.

## Failures

| Cause | Kind | What happens |
|---|---|---|
| gas price above the cap (50 gwei) | transient | wait 15 s and read again; after 10 min, **pause** (resumable) |
| no receipt and the node doesn't know the tx (dropped) | transient | send the same signed bytes again (×2), then re-sign the same nonce at +25% gas price (×2), then pause |
| the nonce was used by something else | — | reconcile: one of our signed versions, or else the step did not run |
| RPC error, 429, timeout, an HTML error page | transient | retry with backoff (×4) |
| simulation reverts (e.g. no such market) | permanent | not sent; **compensate** |
| reverted on chain, or the receipt is fine but the state change is not | permanent | **compensate** |

Compensation undoes the verified steps newest first: `supply → withdraw`, `approve → revoke`, `wrap → unwrap`. Each
compensation is a step with the same checks and retries. If one cannot complete, the saga is `stuck` and the log says
which steps are verified, i.e. where the funds are. WPROS the wallet held before the saga is never unwrapped.

Never retry an unknown error: it is treated as permanent.
