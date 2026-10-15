---
name: pharos-dry-run-executor
description: >
  Use before sending any Pharos transaction to predict whether it will succeed, what it will cost and how
  balances will change, and to refuse sending it when the simulation fails. Reads go through Pharos Chain
  MCP (eth_call, estimate_gas, get_gas_price, get_balance). Pair with pharos-policy-gatekeeper: the
  gatekeeper decides whether the action is allowed, the dry run decides whether it will work.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Dry-Run Executor

## When to use

Before any write action on Pharos mainnet (PROS transfer, ERC-20 transfer or approve, WPROS wrap/unwrap,
any contract call), and whenever the user asks "will this work?" or "what will this cost?".

## How to use

1. Write the transaction to a JSON file:

   ```json
   { "note": "one line: what and why", "from": "0x…", "to": "0x…", "value": "0.5",
     "call": { "fn": "deposit()" } }
   ```

   `value` in PROS; `call` for a contract call (or raw `data`).

2. Simulate and show the user the result:

   ```bash
   node dry-run-executor/dryrun.mjs tx.json
   ```

   Output: `SUCCEEDS` with gas × price = fee, or `REVERTS` with the reason; then balances before → after
   for every balance the call affects (sender PROS including the fee, recipient, token balances, WPROS,
   allowances).

3. Execute only if the user wants it and the simulation passed:

   ```bash
   node dry-run-executor/dryrun.mjs tx.json --execute
   ```

   It simulates again first. On a failed simulation it prints `⛔ BLOCKED`, exits with code 1 and signs
   nothing. On success it signs locally with `PRIVATE_KEY` (must match `from`; the user sets it, never ask
   for it in chat), sends, confirms the receipt through Chain MCP and compares gas used with the prediction.

## Rules for the agent

- A `REVERTS` prediction is a stop. Report the reason and the fix; do not resend with a higher gas limit
  hoping it will pass.
- The simulation is against the latest block. If the user waits a long time before executing, simulate
  again.
