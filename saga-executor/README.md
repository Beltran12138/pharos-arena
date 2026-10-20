# Saga Executor

A Skill ([`SKILL.md`](SKILL.md)) that runs a dependent three-step workflow on Pharos mainnet — **wrap PROS → approve
WPROS to Morpho → supply WPROS to a Morpho Blue market** — as a saga: each step is verified on chain before the next
starts, transient failures are retried, and a permanent failure undoes the verified steps (withdraw, revoke, unwrap)
instead of leaving funds halfway. Every transition is written to a state log.

```bash
node --env-file=.env saga-executor/saga.mjs run --amount 0.01                 # the owner runs it with their key
node --env-file=.env saga-executor/saga.mjs run --amount 0.01 --spike-at wrap --drop-at approve --fail-at supply
node --env-file=.env saga-executor/saga.mjs rollback <saga-id>                # undo a completed saga
node --env-file=.env saga-executor/saga.mjs resume <saga-id>                  # after a pause or a crash
node saga-executor/saga.mjs status <saga-id>                                  # where it is; no key
```

## Steps and how each is verified ([`saga.mjs`](saga.mjs))

| Step | Transaction | Verified by (read at the receipt's block against the block before, two agreeing reads) | Undo |
|---|---|---|---|
| wrap | `WPROS.deposit()` with value | WPROS balance + amount | unwrap: `WPROS.withdraw` of what the saga wrapped (WPROS held before stays) |
| approve | `WPROS.approve(Morpho, amount)` | allowance = amount | revoke: `approve(Morpho, 0)`, allowance = 0 |
| supply | `Morpho.supply(BTCVC/WPROS, amount)` | WPROS balance − amount and supply shares up | withdraw: all the shares, shares = 0 and WPROS back |

Every step: build from current state → `estimate_gas` from the owner (a revert here is permanent and costs nothing)
→ gas-price check → sign (legacy, chain 1672, the pending nonce) → broadcast through Chain MCP `send_raw_transaction`
→ wait for the receipt → status `0x1` → the state check. A receipt alone is not enough: a step is `verified` only
when the state it was for has changed.

BTCVC/WPROS is used because it has ≈ 200k WPROS of available liquidity, so the supply can come straight back out. (The
USDC/WPROS market pays more but had 0.05 WPROS available: a supply there might not be withdrawable.)

## Retry and compensation policy ([`policy.mjs`](policy.mjs))

| Cause | Kind | Action |
|---|---|---|
| gas price above the cap (50 gwei; the network sits at 10) | transient | wait and read again; after 10 minutes **pause** (undoing at a spike costs the same spike) |
| no receipt in 45 s, the node doesn't know the tx | transient (dropped) | rebroadcast the same signed bytes ×2, then re-sign the **same nonce** at +25% gas price ×2, then pause |
| no receipt, the node has it pending | — | keep waiting |
| the account nonce moved past ours | — | reconcile: check every version we signed; if none landed, the step did not run → permanent |
| RPC error, 429, timeout, HTML error page | transient | retry with backoff ×4 |
| simulation revert, on-chain revert, wrong state after a good receipt, unknown error | permanent | **compensate**: undo verified steps newest first, each with the same checks and retries |
| a compensation fails | — | `stuck`: the log shows which steps are verified, i.e. where the funds are |

State log: `state/<saga-id>.jsonl`, one line per transition (`pending → simulated → signed → sent → confirmed →
verified`, or `retrying`, `failed`, and the saga phases `started / compensating / compensated / completed / paused /
stuck`), with the transaction hash and nonce. `status` folds it; `resume` uses it to look up a step that was already
sent before sending anything.

## Runs on mainnet, 2026-10-20 ([`runs/`](runs/), [`state/`](state/))

**A — fully successful** ([`runs/A-success.txt`](runs/A-success.txt)): wrap 0.01 PROS (block 20,749,630, WPROS
+0.01), approve (20,749,638, allowance 0.01), supply (20,749,645, WPROS −0.01, 4,998,783,400,317,250,923,949 supply
shares) → `completed`.

**B — forced failure with recovery** ([`runs/B-forced-failure.txt`](runs/B-forced-failure.txt)), three injected
faults:

1. *gas spike at wrap*: two gas readings replaced by 80 gwei → `retrying … > cap 50 gwei`, twice, then sent at
   10 gwei (block 20,749,814). (That run's message says "waiting 15 s"; for an injected spike it waits 3 s, as the
   timestamps show. The message now prints the real wait.)
2. *dropped transaction at approve*: the signed bytes were not broadcast. After 45 s with no receipt, the node did not
   know the hash and the nonce was still free → **rebroadcast the same bytes** → confirmed in block 20,749,867, same
   hash, allowance 0.01.
3. *permanent failure at supply*: market parameters with `lltv + 1` (a market that doesn't exist) → the simulation
   reverts `market not created`, nothing sent → **compensating**: revoke (20,749,872, allowance 0), unwrap (20,749,879,
   WPROS −0.01) → `compensated`.

**C — rollback of A** ([`runs/C-rollback-of-A.txt`](runs/C-rollback-of-A.txt)): withdraw all of A's shares
(20,749,953, WPROS +0.010000000193980304: the supply earned 1.9e-10 WPROS in six minutes, shares left 0), revoke
(20,749,963, allowance 0 — it already was, the supply used it up; the step is cheap and makes the state explicit),
unwrap 0.01 (20,749,971) → `compensated`.

`status` for both sagas: [`runs/status-saga-20261020T132402.txt`](runs/status-saga-20261020T132402.txt),
[`runs/status-saga-20261020T132710.txt`](runs/status-saga-20261020T132710.txt).

**Checked outside the saga** ([`runs/final-state-direct-rpc.txt`](runs/final-state-direct-rpc.txt), straight from
`rpc.pharos.xyz`, not through Chain MCP): all 10 transactions `success` with the blocks and gas in the logs; afterwards
Morpho supply shares 0, allowance 0, WPROS 0.000400000193980304 (the 0.0004 held before, plus the interest). Gas for
the three runs: 452,446 gas, ≈ 0.0045 PROS.

| Requirement | Where |
|---|---|
| ≥ 3 dependent steps, each verified (receipt checked) before the next | wrap → approve → supply; receipt status + the state change, read at the receipt's block |
| Retry policy for transient failures (gas spike, dropped tx) | `policy.mjs`; run B: spike waited out, dropped approve rebroadcast and confirmed |
| Compensation/rollback path, demonstrated | run B: supply fails → revoke, unwrap; run C: withdraw, revoke, unwrap |
| State log showing which step the saga is in | `state/*.jsonl`, the console lines, `status` |
| One fully successful run and one forced-failure run with recovery | runs A and B (and C) |

Not demonstrated live: a replacement at +25% gas (the dropped approve was recovered by the first rebroadcast), a pause,
and an on-chain revert. The decisions on those paths (replace, pause, revert = permanent) are unit-tested in `test/saga.test.mjs`; forcing them live would cost real gas or ten minutes of waiting.
The agent holds no key: the owner runs the saga, and the key stays in that process.
