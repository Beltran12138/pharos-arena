# Gas Fee Optimizer

Tracks the gas price on Pharos mainnet, holds a non-urgent transaction until gas is favourable or its deadline
arrives, and reports what it actually paid against the price at request time and against what others paid.

```bash
node gas-fee-optimizer/gas.mjs history --hours 24                       # past blocks → history.jsonl, printed
node gas-fee-optimizer/gas.mjs monitor --interval 30 --for 600          # live samples → history.jsonl
node --env-file=.env gas-fee-optimizer/gas.mjs submit request.json     # hold, then sign + send
```

## What the history shows ([`history-24h.txt`](history-24h.txt))

Each sample is a block read through Chain MCP with its transactions: base fee, fullness, how many transactions,
what they paid (median, max) and how many paid above the base fee.

The finding, before any optimizing: **on Pharos mainnet the base fee does not move.** 48 samples over 24 hours
and 104 over 7 days all show 10 gwei; `get_gas_price` returns 10 gwei; blocks have a 1,000,000,000 gas limit and
are ≈ 0% full, so the base fee sits at its floor. Meanwhile 8 of 21 sampled transactions paid above it, on average
15.6% more than the base fee, for nothing. So today the saving is not *when* to send but *not overpaying*; the
timing logic still works when the base fee does move.

## Holding a transaction ([`policy.mjs`](policy.mjs))

A request ([`request-a.json`](request-a.json)): recipient, value, `deadline` (`"+300s"` or an ISO time), optional
`marginSec` (default 20) and `targetGwei`. Without a target, the target is the low end (p10) of the last 24 h of
base fees, never below the floor. Every ~10 s: if gas ≤ target, submit; from `deadline − margin` on, submit
whatever the price, so the transaction is mined by the deadline. It is signed locally and sent through Chain MCP
`send_raw_transaction` at the node's current gas price — never above it.

## Runs on mainnet, 2026-10-20

| Request | What it did | Mined | Paid | vs price at request | vs what others paid meanwhile |
|---|---|---|---|---|---|
| [A](request-a.json), default target, deadline +300 s ([`run-a.txt`](run-a.txt)) | gas 10 gwei ≤ target 10 gwei → submitted at once | [`0xadd5…2964`](https://www.pharosscan.xyz/tx/0xadd56414ddfb380bf1b28a0bda6bb99d6688f264ea4aeed55528169520092964) 09:37:57 | 21,000 × 10 gwei | 10 gwei: saved 0 | 7 txs, avg 10.900 gwei: saved 8.3% |
| [B](request-b.json), target 5 gwei (below the floor, can never be met), deadline +90 s ([`run-b.txt`](run-b.txt)) | held 6 checks, submitted 18 s before the deadline | [`0xa2ac…66ce`](https://www.pharosscan.xyz/tx/0xa2acf477b2baf43a756bbf22d7758558ae1f5a013a95eeca3116b9beb80f66ce) 09:39:23, deadline 09:39:39 | 21,000 × 10 gwei | 10 gwei: saved 0 | 9 txs, avg 10.389 gwei: saved 3.7% |

The saving against the request-time price is 0 in both runs because the price never moved; that is the honest
result on this chain today. Receipts re-read from `rpc.pharos.xyz` directly (not MCP): status 1, 21,000 gas,
10 gwei, mined at the times above. Every run is appended to [`runs.jsonl`](runs.jsonl).

| Requirement | Where |
|---|---|
| Tracks gas price over time, shows recent history | `history` / `monitor`; `history-24h.txt` |
| Holds a transaction until gas is favourable or the deadline | `submit` + `decide()`; run B held, run A did not need to |
| Reports gas paid vs the price at request time | the report of each run; `runs.jsonl` |
| Never misses the deadline | `decide()` submits from deadline − margin; run B; tests |

Tests: `npm test` (`test/gas.test.mjs`: hold/submit, deadline edges including past-deadline starts, target, report).
