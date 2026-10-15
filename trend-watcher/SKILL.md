---
name: pharos-trend-watcher
description: >
  Use when an agent should act on a Pharos trend only once it is confirmed over several observations
  ("price down 3 checks in a row"), not on a single reading. Each run takes one observation through Pharos
  Chain MCP and appends it to a persistent store; the action fires once, when the configured trend is met.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Trend Watcher

## How to use

Schedule one run per interval (cron, Task Scheduler, an agent loop):

```bash
node trend-watcher/trend.mjs observe              # take one observation, evaluate, fire if confirmed
node trend-watcher/trend.mjs history              # show the stored history and when the trend was met
```

`--config` picks another config, `--store` another store file, `--at-block N` observes a past block.

## Config (`trend.json`)

```json
{
  "name": "WPROS/USDC sustained sell-off watch",
  "metric": { "type": "poolPrice", "pool": "0x912c…f647", "label": "…" },
  "rule": { "direction": "down", "observations": 4, "minStepPct": 0.3, "minTotalPct": 1.0 },
  "action": "alert: …",
  "store": "state/wpros-usdc.jsonl"
}
```

Metrics: `poolPrice` (V3 `slot0`) or `feedPrice` (`{ "pair": "PROS/USD" }`, Chainlink). The rule needs
`observations` (≥ 3) consecutive readings, each moving at least `minStepPct` in `direction`, adding up to at
least `minTotalPct`.

## Rules for the agent

- Never edit the store by hand, and never use `--inject` outside a test: injected values are marked in the
  store and in the output.
- One trigger per trend: a confirmed window fires once and is recorded; later runs over the same window
  report "already fired".
- If a run fails (network, rate limit), just run again. Observations are keyed by block, so a retry can't
  create duplicates.
