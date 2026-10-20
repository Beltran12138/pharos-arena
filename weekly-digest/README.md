# Weekly Digest Agent

A periodic summary of the WPROS/USDC pool on Pharos mainnet
([`0x912c…f647`](https://www.pharosscan.xyz/address/0x912c9ade24d44d8922f0866d8dcb079f1363f647), the pool behind
most PROS↔USDC swaps): key numbers against the previous period, the top 3 notable events, delivered to
Telegram (@pharos_lighthouse_alerts_bot) and published as a Markdown page in [`digests/`](digests/).

```bash
# .env: TELEGRAM_BOT_TOKEN=…  TELEGRAM_CHAT_ID=…
node --env-file=.env weekly-digest/digest.mjs schedule [--config digest.json]   # runs forever, one digest per period
node --env-file=.env weekly-digest/digest.mjs run      [--config digest.json]   # the last complete period, now
node weekly-digest/digest.mjs run --no-send                                     # build the page only
```

Latest digest: [`digests/2026-10-12_7d.md`](digests/2026-10-12_7d.md) (week of 2026-10-12, compared with the
week of 2026-10-05).

## Schedule

[`digest.json`](digest.json): `period` (default `7d`; any `Nd`, `Nh`, `Nm`) and `anchor` (default Monday
2026-10-05 00:00 UTC). Periods are `[anchor + k·period, anchor + (k+1)·period)`.

- `schedule` delivers each period 30 s after it ends, then sleeps until the next one. On start it first
  delivers the last complete period if that has not been sent, so a restart neither skips a week nor sends one twice.
- Delivered periods are recorded in `state/sent.json`; `run` checks it too, so `run` can also be put in cron or
  Windows Task Scheduler instead of keeping a process alive, e.g.
  `schtasks /create /sc weekly /d MON /st 08:05 /tn pharos-digest /tr "node --env-file=C:\…\.env C:\…\weekly-digest\digest.mjs run"`.
- Demo of the scheduler with a 10-minute period ([`digest-10m.json`](digest-10m.json)):
  [`schedule-demo-10m.txt`](schedule-demo-10m.txt) shows digests delivered at each period boundary.

## Metrics (this period vs previous)

Swaps, volume (USDC leg), distinct swap recipients, median swap, close price, net WPROS bought by traders,
liquidity added/removed (Mint/Burn), TVL at period end. Open/high/low come from the price after each swap.

| Source (all Chain MCP) | Used for |
|---|---|
| `get_block` (binary search on timestamp) | first block of each period boundary |
| `get_logs` on the pool, topics `[Swap, Mint, Burn]`, 1,000 blocks per call | every swap and liquidity change (602 calls for one week) |
| `eth_call` at the period's last block: `slot0`, `balanceOf` of both tokens | close price and reserves (TVL). Taken only when two reads agree (`readAgreed`; the RPC returned wrong historical state in 2–5% of reads in our tests) |

Each period's numbers are saved in `state/period-*.json`, so next week's digest reuses this week's as "previous".

## Top 3 notable events

Candidates: the largest swaps, the largest liquidity changes, the sharpest one-hour price move, the busiest day.
Each is scored by how unusual it is for the period: its size divided by the period's own median of the same kind
(e.g. "67× the median swap"). The top 3 by score are reported, at most one of them a swap unless there are too
few other candidates. The median one-hour move has a floor of 0.01%, so a flat market does not make a small move
look infinitely unusual.

## Checks on the 2026-10-12 digest

- Reserve closure: there were no Mint/Burn events in either week, so the change in the pool's WPROS reserve
  between the two period ends must equal what traders sold into the pool. Reserve change +34,828.62818,
  net sold by traders 34,828.62818 (difference 3·10⁻⁸): no `get_logs` window was missed.
- The close price from the last swap equals `slot0` read at the period's last block.
- The largest swap (`0xa96e…85ac`, $5,209) read again from `rpc.pharos.xyz` directly, not through MCP: same
  amounts (7,561.27 WPROS in, 5,208.88 USDC out).
- Delivery: [`run-2026-10-20.txt`](run-2026-10-20.txt) — delivered to Telegram, and a second `run` refused to send
  the same period again.

| Requirement | Where |
|---|---|
| Runs on a schedule, weekly by default, configurable | `schedule`, `digest.json` `period`/`anchor`; 10-minute demo |
| Key metrics with comparison to the previous period | metrics table; `summarize()` in `metrics.mjs` |
| Top 3 notable events | `notable()`; scoring explained above |
| Delivers to a real channel or a published page | Telegram, and `digests/*.md` in this public repo |

Limits: "distinct swap recipients" counts the Swap event's `recipient`, which is the trader for direct swaps and
a router for routed ones, so it undercounts people. USD values use USDC at $1.

Tests: `npm test` (`test/weekly-digest.test.mjs`: price decimals, sign convention, notable ranking, flat-market
floor, period calendar).
