# Trend Watcher

A Skill ([`SKILL.md`](SKILL.md)) with memory. Each run takes **one** observation through Chain MCP and
appends it to a persistent store. The action fires only when a trend is confirmed over several stored
observations, never on a single reading.

```bash
node trend-watcher/trend.mjs observe     # one scheduled run
node trend-watcher/trend.mjs history     # stored history, with the trigger marked
```

- **Metric:** WPROS/USDC pool price (V3 `slot0` at the run's block, through Chain MCP `eth_call`).
- **Rule** ([`trend.json`](trend.json)): 4 consecutive observations, each down ≥ 0.3%, at least 1.0% down in
  total. All configurable; at least 3 observations enforced.
- **Store:** append-only JSONL ([`state/wpros-usdc.jsonl`](state/wpros-usdc.jsonl)). Observations are
  keyed by block number, so a re-run for a stored block adds nothing. Triggers are stored, so a trend that
  fired is not fired again after a restart.

## Demo: 47 scheduled runs, each a separate process ([`demo-runs.txt`](demo-runs.txt))

One run every 600 blocks (~10 minutes) over 7.7 hours of mainnet history (blocks 20,296,345 → 20,323,945),
replayed with `--at-block`. Every run is a new process that reads the store, adds one observation and exits,
so persistence across runs is exercised 47 times.

- **Restart without duplicates:** after the run for block 20,305,945 the scheduler runs it again →
  `block 20305945 already observed; nothing added (store has 17 observations)`.
- **Crash and recovery:** the run for block 20,316,145 failed with a real network error (TLS socket
  closed) before writing anything. Re-running it later added it as observation #47; the store sorts by
  block, so the history is complete and in order.
- **The moment the trend was met** ([`history.txt`](history.txt)):

```
  # 38 block 20319145 2026-10-15T15:50  0.605463  -0.189%
  # 39 block 20319745 2026-10-15T16:00  0.603114  -0.388%
  # 40 block 20320345 2026-10-15T16:10  0.600925  -0.363%
  # 41 block 20320945 2026-10-15T16:21  0.598815  -0.351%   <<< TRIGGER (window #38–#41, -1.098%)
```

  ```
  >>> TREND CONFIRMED at observation #41 (block 20320945, 2026-10-15T16:21:00.000Z): 4 consecutive down observations, -1.098% in total
  >>> action: alert: sustained PROS sell-off confirmed; pause new PROS buys and review exposure
  ```

  The next five runs reported `trend already fired for the window starting at block 20319145; not firing again`.

## A single spike does not trigger it ([`spike-demo.txt`](spike-demo.txt))

Real observations around one injected outlier (marked `[injected]` in the store and the output):

```
  #  1 block 20322145 2026-10-15T16:41  0.598375
  #  2 block 20322745 2026-10-15T16:51  0.597047  -0.222%
  #  3 block 20323345 2026-10-15T17:01  0.510000  -14.580%  [injected]
  #  4 block 20323945 2026-10-15T17:10  0.596913  +17.042%
  #  5 block 20324545 2026-10-15T17:20  0.599275  +0.396%
```

A −14.6% step is one observation; the next one goes back up, the streak resets, nothing fires. The rule is
also covered by `test/trend.test.mjs` (spike, pause in the middle, steps too small, total too small,
direction).

## Why single readings can't be trusted here: bad reads from the endpoint

While preparing this demo, two reads of the pool price at fixed past blocks came back wrong: block
20,301,145 read once as 0.6987 (true value 0.5884) and block 20,322,745 as 0.6472 (true 0.5970). Repeating
the same `eth_call` at the same block: **4 of 80 reads through Chain MCP and 1 of 40 through
`rpc.pharos.xyz` directly returned a different, wrong state.** The error is in the RPC backend, not the
MCP layer.

So the metric is now read with `readAgreed` ([`lib/pharos.mjs`](../lib/pharos.mjs)): at a pinned block, a
value is used only once two reads return the same bytes (up to 5 tries). After the change, all 47 stored
observations were re-read this way: **47 of 47 matched**. The other builds that read prices at a pinned
block (Threshold Guardian, pool and Chainlink reads in `lib/`) use the same function.

| Requirement | Where |
|---|---|
| State between runs in persistent storage | `state/*.jsonl`, one process per run |
| Trend rule ≥ 3 observations, configurable | `rule.observations` (≥ 3 enforced), step, total, direction |
| Restarts without losing or duplicating history | block-keyed store; re-run → "already observed"; crashed run recovered |
| Stored history and the exact moment the trend was met | `history.txt`, observation #41, block 20,320,945 |
| A single spike does not trigger | `spike-demo.txt` + unit tests |
