# Policy Gatekeeper

A Skill ([`SKILL.md`](SKILL.md)) that sits in front of an agent's on-chain actions on Pharos. Each requested
action is checked against [`policy.json`](policy.json) before anything is signed. The answer is `allow` or
`deny` plus the rule that decided it; every decision goes into a hash-chained audit log.

```bash
node policy-gatekeeper/gatekeeper.mjs check scenario.json   # dry-run: decide, log, simulate allowed ones
node policy-gatekeeper/gatekeeper.mjs exec  action.json     # live: decide, log, sign + send allowed ones
node policy-gatekeeper/gatekeeper.mjs verify                # check the audit log's hash chain
```

## Rules

| Rule | Denies when |
|---|---|
| `allowlist.recipient` | a PROS transfer, or an ERC-20 `transfer`/`transferFrom`, goes to an address not on the list |
| `allowlist.spender` | an ERC-20 `approve` names a spender not on the list |
| `allowlist.contract` | the call targets a contract not on the list |
| `allowlist.function` | the contract is listed but this function selector is not |
| `timeWindow` | the request time (UTC) is outside every window |
| `spendLimit.perTx` | one action moves more than the per-transaction limit of that token (PROS or a known ERC-20) |
| `spendLimit.perDay` | today's allowed total plus this action exceeds the daily limit |

A token with no limit configured cannot be spent at all. The first failing rule decides; all checks are
recorded. ERC-20 calldata is decoded so that a USDC transfer counts against the USDC limit and its real
recipient, not the token contract, is checked against the allowlist.

## Where Chain MCP comes in

- `estimate_gas`: every allowed action is simulated before it could be sent; a simulation failure is logged
  and the action is not sent.
- `get_gas_price`, `get_balance`: in `exec`, refuse to send if the balance cannot cover value + gas.
- `get_transaction_receipt`: in `exec`, confirm the sent transaction.

Signing is local (viem) with the user's `PRIVATE_KEY`; `exec` refuses a key that is not `policy.signer`.
Denied actions never reach the signer.

## Demo: one deny per rule type

[`scenario.json`](scenario.json) has 10 requests. Output of `check` ([`sample-dryrun.txt`](sample-dryrun.txt),
log [`sample-dryrun.jsonl`](sample-dryrun.jsonl)):

| # | Request | Decision | Rule |
|---|---|---|---|
| a1 | 0.0001 PROS to the burn address | allow (simulated, 21,000 gas) | – |
| a2 | wrap 0.0005 PROS via WPROS `deposit()` | allow (simulated, 36,735 gas) | – |
| d1 | PROS to an address not on the list | deny | `allowlist.recipient` |
| d2 | USDC `transfer` to an address not on the list | deny | `allowlist.recipient` |
| d3 | `approve` on LINK, a contract not on the list | deny | `allowlist.contract` |
| d4 | unlimited `approve` on WPROS | deny | `allowlist.function` |
| d5 | allowed transfer at 02:30 Hong Kong time | deny | `timeWindow` |
| d6 | 0.005 PROS (limit 0.001 per tx) | deny | `spendLimit.perTx` |
| a3 | 0.0009 PROS, today's total 0.0015 | allow | – |
| d7 | another 0.0009 PROS, total would be 0.0024 (limit 0.002) | deny | `spendLimit.perDay` |

The time-window deny uses a simulated clock (`"at"` in the request), which only `check` accepts and which is
marked `simulatedClock: true` in the log. `exec` always uses the real time.

## Live on Pharos mainnet ([`audit.jsonl`](audit.jsonl))

`exec` with [`live-requests.json`](live-requests.json), signer `0x6Ea606Ec600F47411Bf56DF699cF695A0b0E9071`
(the only key `policy.json` accepts), real clock (2026-10-20 06:54 UTC, inside the window):

| # | Request | Decision | What happened on chain |
|---|---|---|---|
| 9 | L1: 0.0001 PROS to 0x…dEaD | allow | [`0x272a2528…207e`](https://www.pharosscan.xyz/tx/0x272a2528a5e7fb780678a8e3c0a558cd3c5e3494052e5d72b66a9b7e73e0207e), block 20,725,572, success, gas 21,000 |
| 10 | L2: wrap 0.0005 PROS via WPROS `deposit()` | allow | [`0xa933bdd6…7c44`](https://www.pharosscan.xyz/tx/0xa933bdd6591608d7dd7915c3ab92c81d00af5102d69e7f2f71de7ea6f4ed7c44), block 20,725,621, success, gas 44,942 |
| 11 | L3: PROS to a non-allowlisted address | **deny** `allowlist.recipient` | nothing signed |
| 12 | L4: 0.005 PROS (limit 0.001) | **deny** `spendLimit.perTx` | nothing signed |

The signer's history on the explorer has exactly these two outgoing transactions: the denied requests never
reached the key. Both were signed locally and broadcast through Chain MCP `send_raw_transaction`.

The log also shows what happened before the wallet was funded: decisions #1–#8 are the same four requests
run twice against an empty wallet. L1 and L2 were allowed by the policy but stopped by the `estimate_gas`
simulation ("not enough funds"), so nothing was sent.

Two bugs found by this run, both fixed: (1) the MCP returns `{ txHash }`, which the first version did not
unwrap, so #9 and #10 were logged as `sent-unconfirmed` with a broken link. Lines #13 and #14 are
confirmations appended afterwards by `gatekeeper.mjs confirm`, which reads the receipts through Chain MCP
and points back to the decision (`ofSeq`); the hash chain means past lines are never rewritten. (2) The first
`confirm` stored the transaction hash in a field named `hash`, which collided with the chain's own field, and
`verify` failed. Those two lines were removed before the log was ever published and written again;
`append` now refuses the reserved fields `seq`, `prevHash`, `hash`. Broadcast transactions also count
toward the daily limit even before they are confirmed.

## Audit log

One JSON line per decision: time, mode, the request, decision, deciding rule, all checks, spend, and the
execution result (gas, tx hash, link). Each line holds the SHA-256 of the previous line, so
`gatekeeper.mjs verify` reports the first line that was edited or removed. Daily spend is computed from the
log, so the limit survives restarts.

| Requirement | Where |
|---|---|
| Policy with ≥3 rule types: spend limit, allowlist, time window | `policy.json`; evaluation in `policy.mjs` |
| Every request returns allow/deny with the deciding rule | `evaluate()` → `{ decision, rule, reason, checks }` |
| Denied actions never executed; ≥1 deny per rule type | `exec` only signs `allow`; demo table above |
| Audit log of all decisions | `auditlog.mjs`, `sample-dryrun.jsonl`, `verify` |

Tests: `npm test` (7 cases, including inclusive limits, the window end, ERC-20 decoding and tamper
detection); each was checked to fail when the rule it covers is broken.
