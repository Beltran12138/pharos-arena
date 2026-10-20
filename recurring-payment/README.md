# Recurring Payment Agent

Rent, subscription or payroll-style payments on a weekly or monthly schedule. The agent prepares each due payment
as an unsigned transaction on time, tracks every instance as pending / paid / failed in an append-only ledger,
and reconciles against the chain. The payer signs with a separate signer; the agent never holds a key.

```bash
node recurring-payment/agent.mjs tick                 # prepare what is due, reconcile what was paid
node recurring-payment/agent.mjs status               # history per schedule + next payment
node recurring-payment/agent.mjs watch --interval 300 # tick on a timer
node recurring-payment/agent.mjs release <instance>   # payer: "this one did not pay", re-prepare next tick
node --env-file=.env recurring-payment/sign.mjs out/<instance>.json   # the payer signs one prepared payment
```

## Schedules ([`schedules.json`](schedules.json))

`{ id, to, token, amount, every: "weekly" | "monthly", start }`. Monthly keeps the start's day of the month and
clamps to the last day (a schedule from the 31st pays on Feb 28). Each due date is an instance, `rent@2026-10-20`.

## Each tick, per unpaid instance that is due

1. **Already paid?** The payer's outgoing transfers since the due date are listed from the explorer and each is
   confirmed by its receipt through Chain MCP. A transfer of the same token, to the same recipient, for the exact
   amount, at or after the due time, pays the instance — and is then used up: one transfer pays one instance.
2. **Prepared and outstanding?** Wait for the payer. If the prepared nonce has been used but no matching payment
   is visible, the instance becomes **unconfirmed**: it is re-checked every tick and **never re-prepared on its
   own**. Only `release` (the payer saying it did not pay) reopens it.
3. **Otherwise prepare it**, if the payer can afford it on top of the payments already prepared: on-chain checks
   from [`lib/payment.mjs`](../lib/payment.mjs) (balance, `estimate_gas` from the payer, gas), consecutive nonces for
   outstanding preparations, the instance id in the calldata. If it cannot be paid, it is logged as **failed**
   with the reason and tried again next tick.

No double payment: a payment is prepared only after the chain shows it is unpaid; a preparation has a fixed nonce,
so signing the same file twice cannot pay twice; and the signer refuses a file whose instance the ledger shows as
paid or whose preparation was replaced — before it even loads the key.

## Run on mainnet, 2026-10-20

Payer `0x6Ea6…9071`. Rent 0.0001 WPROS weekly and payroll 0.0001 PROS weekly to `0x6649…04c5` (the payer's own
second wallet), and a 1 USDC monthly subscription the payer cannot afford.

| Step | File | What happened |
|---|---|---|
| tick 1 | [`run-1-tick.txt`](run-1-tick.txt), [`run-1-status.txt`](run-1-status.txt) | rent prepared (nonce 2), payroll prepared (nonce 3), subscription **failed**: 0 USDC |
| payer signs | [`run-2-sign.txt`](run-2-sign.txt) | rent [`0x4974…e545`](https://www.pharosscan.xyz/tx/0x497415a31e5380ff76934de68f1204c6d40e113c3679dc3a370c01cf8569e545) and payroll [`0xf6e7…6ce6`](https://www.pharosscan.xyz/tx/0xf6e7c75f2b836e17490b515cd8044bc1321a029e8cb6343eae7031f62fe46ce6) succeed; signing rent again is **refused** (nonce 2 already used) |
| tick 2 | [`run-3-tick.txt`](run-3-tick.txt) | payroll **paid**. Rent: **bug** — see below |
| tick 3 (fixed) | [`run-4-tick.txt`](run-4-tick.txt), [`run-4-status.txt`](run-4-status.txt) | rent **paid** (`0x4974…`), subscription failed (attempt 3), next payments 10-27 / 10-27 / 11-01 |
| signer | [`run-5-sign-refused.txt`](run-5-sign-refused.txt) | the extra rent file from the bug is **refused**: rent is already paid |

**The bug this run found.** In tick 2 the rent payment was on chain, but the lookup missed it: the explorer labels
the WPROS contract's symbol "PROS", and the first version identified tokens by that label. The old rule then saw
"nonce 2 used, no payment found", called the preparation stale and prepared rent again with nonce 4 — a file that,
if signed, would have paid rent twice. Nothing was signed. Two fixes: tokens are now identified by contract
address; and a used nonce without a visible payment no longer leads to a new preparation (it becomes
*unconfirmed* and only the payer can release it). The signer also checks the ledger first, so the nonce-4 file is
refused. The ledger ([`ledger.jsonl`](ledger.jsonl)) is append-only and keeps the whole sequence, including the
wrong `stale` / `prepared 4` lines.

| Requirement | Where |
|---|---|
| Weekly or monthly schedule with amount, token, recipient | `schedules.json`; `dueTimes()` |
| Prepares each payment on time; tracks paid, pending, failed | `tick` / `watch`; `ledger.jsonl` |
| Insufficient balance or failed tx without double-paying | subscription fails and retries; matching, fixed nonces, unconfirmed state, signer checks |
| Payment history and next scheduled payment | `status` |

Tests: `npm test` (`test/recurring.test.mjs`: calendars and month-end, ledger states including unconfirmed,
payment matching and one-transfer-one-instance).
