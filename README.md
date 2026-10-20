# pharos-arena

Builds for the [Pharos Agent Arena](https://pharos-agent-arena.vercel.app/) (Season of AI). Every chain
read goes through the hosted **Pharos Chain MCP** (`https://mcp.pharos.xyz/mcp`, no key) and every docs
lookup through the **Developer Docs MCP** (`https://docs.pharos.xyz/~gitbook/mcp`). Transactions are signed
locally and broadcast through Chain MCP `send_raw_transaction`; the public RPC is only a fallback.

| Build | Arena task | What it does |
|---|---|---|
| [`read-contract-state/`](read-contract-state/) | Read Contract State (Easy) | Reads a contract at one pinned block and explains it in plain words |
| [`event-log-monitor/`](event-log-monitor/) | Event/Log Monitor (Easy) | Watches one event on one contract, block by block, no duplicates across restarts |
| [`doc-search-cli/`](doc-search-cli/) | Doc-Search CLI (Easy) | `pharos-docs "question"`: short sourced answer, or "the docs don't cover this" |
| [`docs-mcp-onboarding/`](docs-mcp-onboarding/) | Docs MCP Onboarding (Easy) | A docs-only onboarding log with the gaps found and the fix for each |
| [`dapp-support-agent/`](dapp-support-agent/) | dApp Support Agent (Easy) | Explains why a transaction failed and what to do |
| [`policy-gatekeeper/`](policy-gatekeeper/) | Policy Gatekeeper (Medium) | Allows or denies each action against spend limits, allowlists and time windows; hash-chained audit log |
| [`dry-run-executor/`](dry-run-executor/) | Dry-Run Executor (Medium) | Simulates a transaction, predicts balances, blocks it if it would fail |
| [`threshold-guardian/`](threshold-guardian/) | Threshold Guardian (Medium) | Fires an action only when several on-chain conditions all pass; decision trace |
| [`docs-chain-mcp-agent/`](docs-chain-mcp-agent/) | Docs MCP + Chain MCP Agent (Medium) | Explains a function from the docs, calls it, interprets the result, flags docs/contract mismatches |
| [`audit-log-agent/`](audit-log-agent/) | Audit-Log Agent (Medium) | A plain-language activity report for a wallet over a date range (Markdown + CSV) |
| [`wallet-risk-checker/`](wallet-risk-checker/) | Wallet Risk Checker (Medium) | Nine red-flag signals before you interact with an address; LOW / MEDIUM / HIGH with reasons |
| [`whale-watching-agent/`](whale-watching-agent/) | Whale-Watching Agent (Medium) | Significant moves of a watch list, explained from receipts; cross-wallet patterns |
| [`trend-watcher/`](trend-watcher/) | Trend Watcher (Hard) | Persistent observations; fires only on a trend confirmed over several runs, never on one spike |
| [`alert-bot/`](alert-bot/) | On-Chain Alert Bot (Easy) | Large transfers and Chainlink price crossings to Telegram, each alert once |
| [`weekly-digest/`](weekly-digest/) | Weekly Digest Agent (Medium) | WPROS/USDC pool week vs previous week, top 3 notable events, to Telegram + a published page, on a schedule |
| [`skill-chain-mcp-flow/`](skill-chain-mcp-flow/) | Skill + Chain MCP Flow (Medium) | A trade-timing Skill decides TRADE / SPLIT / WAIT from pool, oracle and tick-range state read through Chain MCP |
| [`liquidation-watchdog/`](liquidation-watchdog/) | Liquidation Watchdog (Medium) | Morpho Blue positions: health factor with accrued interest, warn/critical alerts to Telegram with repay-or-add-collateral amounts |
| [`natural-language-payment/`](natural-language-payment/) | Natural-Language Payment Agent (Medium) | "send 100 USDC to alice" → questions on ambiguity → on-chain checks → summary → unsigned tx + EIP-681 request |
| [`recurring-payment/`](recurring-payment/) | Recurring Payment Agent (Medium) | Weekly/monthly payments prepared on time, reconciled on chain, pending/paid/failed ledger, no double pay |
| [`gas-fee-optimizer/`](gas-fee-optimizer/) | Gas Fee Optimizer (Medium) | Gas history from blocks; holds a tx until gas is low or the deadline; reports paid vs request-time and vs others |
| [`batch-executor/`](batch-executor/) | Batch Executor (Medium) | Simulate each transfer, leave failures out, one all-or-nothing Multicall3 batch; 6 transfers for 35% less gas |
| [`arbitrage-scanner/`](arbitrage-scanner/) | Arbitrage Scanner (Hard) | Four WPROS/USDC pools + Chainlink per scan; size-optimized net after fees, impact, gas, slippage; acts only above a threshold |
| [`portfolio-assistant/`](portfolio-assistant/) | Portfolio Assistant (Hard) | Plain-language questions over wallet, vaults and Morpho positions, every number with contract + block |
| [`yield-optimizer/`](yield-optimizer/) | Yield Optimizer (Hard) | 17 USDC/WPROS sources (vaults + Morpho), redemption mode from implementation code, net gain over a holding period, or stay put |
| [`multi-protocol-aggregator/`](multi-protocol-aggregator/) | Multi-Protocol Aggregator (Hard) | Morpho + vaults behind one interface; rates, positions, routed deposit/withdraw prepared for signature; survives a protocol outage |
| [`doc-grounded-builder/`](doc-grounded-builder/) | Doc-Grounded Builder (Hard) | "How do I …?" → Docs MCP answer → steps parsed from its own commands, each fact checked on a getPage page → Chain MCP, verified over a second channel; refuses what the docs don't back |
| [`saga-executor/`](saga-executor/) | Saga Executor (Hard) | Skill: wrap → approve → supply to Morpho, each verified on chain before the next; retries gas spikes and dropped txs; undoes verified steps on failure; state log |
| [`x402-paywalled-api/`](x402-paywalled-api/) | x402 Paywalled API (Medium) | Atlantic x402: 3 paid routes selling live mainnet data + free routes, own facilitator; 402 → pay → 200 checked on chain; underpaid/forged/replayed → 402 |
| [`x402-agent-buyer/`](x402-agent-buyer/) | x402 Agent Buyer (Hard) | Buys Morpho risk data within a budget and per-call cap; nonce-keyed ledger, lost answers resolved on chain, reconciled against every transfer |
| [`invoice-to-payment/`](invoice-to-payment/) | Invoice-to-Payment Agent (Medium) | Text / JSON / EIP-681 invoices → flags (totals, payee redirection, duplicates) → unsigned payment with the reference in calldata |

**Finding along the way:** the same historical `eth_call` at a fixed block sometimes returns a wrong state
(4 of 80 reads through Chain MCP, 1 of 40 through `rpc.pharos.xyz`). Values that drive a decision are read
with `readAgreed` (two identical answers required). Details in [`trend-watcher/`](trend-watcher/README.md).

Requirements of every task, copied from the arena: [`TASKS.md`](TASKS.md).

```bash
npm install
node read-contract-state/read.mjs                                   # WPROS by default
node policy-gatekeeper/gatekeeper.mjs check policy-gatekeeper/scenario.json
node doc-search-cli/pharos-docs.mjs "how do I deploy a contract?"
node audit-log-agent/report.mjs --wallet 0x… --from 2026-10-01 --to 2026-10-15
npm test
```

Node 20+. Chain MCP tools used: `get_block_number`, `get_block`, `get_code`, `get_balance`,
`get_transaction_count`, `eth_call`, `estimate_gas`, `get_gas_price`, `get_logs`, `get_transaction`,
`get_transaction_receipt`, `send_raw_transaction`. Docs MCP tools used: `askQuestion`,
`searchDocumentation`, `getPage` (never `sendFeedback`). The hosted Chain MCP allows 120 requests per
minute per IP; the client backs off on 429. Shared code: [`lib/`](lib/) (MCP clients, Pharos constants and
Chainlink feeds, V3 pool reads, local signing + MCP broadcast).

## Where this comes from

The gatekeeper is a Pharos port of the policy side of
[Warrant](https://github.com/Beltran12138/warrant): a principal writes down what an agent may do, every
action is checked before it is signed, and the record of decisions can be shown to someone else. Warrant
puts the policy and the disclosures on chain; here the policy is a local file and the log is hash-chained,
which is the right weight for a single agent's operator.

## AI disclosure

Written with an AI coding assistant (Claude Code). Design choices, test cases and every sample output were
reviewed by hand; sample outputs in this repo are real runs against Pharos mainnet.

## License

MIT
