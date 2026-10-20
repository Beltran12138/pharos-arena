# On-Chain Alert Bot

Watches Pharos mainnet for the conditions in [`rules.json`](rules.json) and sends each alert once to a
Telegram chat (bot: @pharos_lighthouse_alerts_bot).

```bash
# .env: TELEGRAM_BOT_TOKEN=…  TELEGRAM_CHAT_ID=…
node --env-file=.env alert-bot/bot.mjs [--rules rules.json] [--state state.json] [--interval 5] [--from-block N] [--for seconds]
node alert-bot/bot.mjs --console    # no Telegram: timestamped alerts on the console
```

## Conditions

| Type | Rule fields | Source |
|---|---|---|
| `transfer` | `token` (USDC, WPROS, LINK, WETH), `min` | Chain MCP `get_logs`, ERC-20 `Transfer`, all tokens in one query per 1,000 blocks |
| `price` | `pair` (Chainlink feed), `above` or `below`, `rearmPct` | Chainlink feed `latestRoundData` through Chain MCP `eth_call` |

Default rules: USDC ≥ 1,000, WPROS ≥ 5,000, PROS/USD ≥ 0.62, PROS/USD ≤ 0.55.

## What an alert contains

What happened (rule and threshold), the value, the parties and block (or the feed), and a PharosScan link to
the transaction (or the feed contract for price alerts):

```
Large USDC transfer (≥ 10,000 USDC)
Value: 185,000 USDC
0x8eCD…Ab9f → 0x798d…83b2, block 20723887
View on PharosScan → https://www.pharosscan.xyz/tx/0xe845c449…15a8
```

## No repeat spam

- Each transfer alert has the id `rule:txHash:logIndex`. Delivered ids are saved in `state.json` with the next
  block to scan, so overlapping polls and restarts never send the same transfer twice.
- A price rule alerts when the price crosses its line, then is disarmed. It re-arms only after the price has
  moved back past the line by `rearmPct` (default 0.5%), so a price hovering at the line does not alert on every
  poll. The arming state is saved too.
- An alert that Telegram rejects stays in a pending queue and is retried next poll; it is marked delivered only
  after Telegram returns `ok`.

## Runs on mainnet, 2026-10-20

- [`live-run.txt`](live-run.txt): 3 minutes live with the default rules, delivered to Telegram. PROS/USD was
  0.6256, above the 0.62 line, so one price alert; no transfer reached 1,000 USDC in that window.
- [`backfill-run.txt`](backfill-run.txt): rules [`rules-backfill.json`](rules-backfill.json) (USDC ≥ 10,000)
  over the previous hour, 7 alerts delivered to Telegram.
- Restart check (console mode): a 3-hour scan produced 30 alerts; a second run with the same state file sent 0.
- Cross-check: transfer `0xb050e7b6…ff93` was reported as 9,990 USDC in block 20,723,079; the receipt read
  directly from `rpc.pharos.xyz` (not through MCP) shows the same value and block.

| Requirement | Where |
|---|---|
| At least one configurable alert condition | two types in `rules.json`; logic in `rules.mjs` |
| Delivers to a real channel | Telegram `sendMessage`; `live-run.txt`, `backfill-run.txt` |
| What happened, the value, a tx or explorer link | `transferAlerts` / `priceAlert` → `format` |
| No repeat spam | `Seen` ids + saved block cursor; price re-arm margin; tests |

Tests: `npm test` (`test/alert-bot.test.mjs`: threshold boundary, one id per log, re-arm margin, restored
dedup state).
