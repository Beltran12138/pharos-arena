---
name: pharos-policy-gatekeeper
description: >
  Use before ANY Pharos write action (send PROS, ERC-20 transfer/approve, contract call, deploy) that an
  agent is about to take, including actions planned with the pharos-skill-engine skill. Checks the action
  against the owner's policy (spend limits, allowlisted recipients/contracts/functions, allowed time
  windows), logs the decision to a hash-chained audit log, and only then simulates and executes it.
  Never execute a Pharos write action that this gatekeeper denied or did not see.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Policy Gatekeeper

A gate in front of an agent's on-chain actions on Pharos mainnet (chain 1672). The agent proposes an
action; the gatekeeper decides allow or deny from `policy.json` and names the rule that decided it. Chain
reads (balance, gas price, `estimate_gas`, receipts) go through the Pharos Chain MCP server
(`https://mcp.pharos.xyz/mcp`).

## When to use

Every time you are about to send a Pharos transaction for the user. This replaces running `cast send` /
`forge script --broadcast` directly. Read-only queries (`cast call`, `cast balance`) do not need the gate.

## How to use

1. Write the proposed action(s) to a JSON file (one object or an array):

   ```json
   { "id": "pay-1", "note": "what and why, in one line",
     "to": "0x…", "value": "0.0001",
     "call": { "fn": "transfer(address,uint256)", "args": ["0x…", "100000"] } }
   ```

   `value` is in PROS (omit for 0). Use `call` for a contract call, or `data` with raw calldata. Omit both
   for a plain PROS transfer.

2. Dry-run first and show the user the result:

   ```bash
   node policy-gatekeeper/gatekeeper.mjs check action.json
   ```

   Output per action: `ALLOW` or `DENY`, the deciding `rule` (`allowlist.recipient`, `allowlist.contract`,
   `allowlist.function`, `allowlist.spender`, `timeWindow`, `spendLimit.perTx`, `spendLimit.perDay`), and
   the reason. Allowed actions are simulated with Chain MCP `estimate_gas`.

3. Only if the user wants it executed, and only for actions that were allowed:

   ```bash
   node policy-gatekeeper/gatekeeper.mjs exec action.json
   ```

   `exec` re-evaluates with the real clock, needs `PRIVATE_KEY` in the environment (the user sets it; never
   ask for it in chat, never print it), refuses if the key does not belong to `policy.signer`, signs locally
   and broadcasts. The server never sees the key.

4. To show what the agent did, or to prove the log was not edited:

   ```bash
   node policy-gatekeeper/gatekeeper.mjs verify
   ```

## Rules for the agent

- **A deny is final.** Do not retry the same action with a smaller amount split across transactions, a
  different recipient the user did not ask for, or a changed clock to get around a rule. Report the rule
  and the reason to the user and stop.
- **Do not edit `policy.json` or `audit.jsonl`.** The policy is the owner's; changing it is the owner's
  decision, made outside the agent session.
- `at` in a request is honoured only by `check` (dry-run, recorded as a simulated clock) for testing time
  windows. `exec` always uses the real time.

## Policy file

```json
{
  "version": 1,
  "signer": "0x… (the only key exec will sign with)",
  "allowlist": {
    "recipients": ["0x…"],
    "contracts": { "0xToken…": ["transfer(address,uint256)"], "0xVault…": ["deposit()"] }
  },
  "spendLimit": { "perTx": { "PROS": "0.001", "USDC": "0.5" }, "perDay": { "PROS": "0.002", "USDC": "1" } },
  "timeWindows": [{ "name": "…", "days": ["mon", "…"], "from": "00:00", "to": "16:00" }]
}
```

Times are UTC. A token with no spend limit cannot be spent. ERC-20 `transfer`/`transferFrom` on a known
token count as spend of that token, and their recipient must be allowlisted; an `approve` spender must be
allowlisted too. Daily spend is summed from allowed decisions in the audit log for the same UTC day.
