### arbitrage-scanner
Hard
SkillEngine
Arbitrage Scanner
Checks price/rate across two sources, nets fees, executes only if profitable.
Points
200
Build on
ai.pharos.xyz
What you'll build
A Skill that compares a price or rate across two sources (two pools, a pool versus an oracle, etc.), nets out fees and gas, and only acts when the opportunity is still profitable after costs.
Requirements
01
Reads prices from at least 2 sources in the same scan.
02
Calculates net profit after swap fees, slippage estimate, and gas.
03
Acts (or prepares the transaction) only above a configurable profit threshold; otherwise logs why it skipped.
04
Logs every scan with gross spread, costs, net result and decision.
05
Works safely on testnet or with simulated execution; no requirement to risk real funds.
Reviewers score against this list. Missing items can mean partial points.

### audit-log-agent
Medium
Compliance / Security
Audit-Log Agent
Generates a plain-language activity report for a wallet over a period.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that generates a plain-language activity report for a wallet over a chosen period, the kind of summary a compliance officer or accountant could read.
Requirements
01
Accepts a wallet address and a date range.
02
Groups activity into categories: transfers in and out, swaps, approvals, contract interactions.
03
Includes totals per category and notable transactions with links.
04
Exports the report as Markdown, PDF or CSV.
Reviewers score against this list. Missing items can mean partial points.

### batch-executor
Medium
SkillEngine
Batch Executor
Bundles several independent actions into one optimized execution.
Points
100
Build on
ai.pharos.xyz
What you'll build
A Skill that takes several independent actions, such as multiple transfers or claims, and bundles them into one optimized execution instead of firing them one by one.
Requirements
01
Accepts a list of at least 3 independent actions.
02
Executes them as a batch: multicall, a single prepared transaction, or an equivalent.
03
Reports the gas saving or step reduction compared with running them individually.
04
Handles partial failure clearly: which action failed and what happened to the rest.
Reviewers score against this list. Missing items can mean partial points.

### dapp-support-agent
Easy
Support / Reporting
dApp Support Agent
Explains why a transaction failed, on request.
Points
50
Build on
ai.pharos.xyz
What you'll build
A support agent that takes a failed transaction hash and explains, in plain language, why it failed and what the user can do about it.
Requirements
01
Accepts a tx hash and fetches the transaction and receipt via Chain MCP.
02
Identifies the failure cause: revert reason, out of gas, insufficient balance or allowance, etc.
03
Explains it without jargon and suggests a fix.
04
Demonstrated on at least 3 different failure types.
Reviewers score against this list. Missing items can mean partial points.

### doc-grounded-builder-agent
Hard
Cross-tool / Advanced
Doc-Grounded Builder Agent
Answers "how do I do X on Pharos" via Docs MCP, then does X via Chain MCP/SkillEngine.
Points
200
Build on
ai.pharos.xyz
What you'll build
An agent that handles "how do I do X on Pharos?" end to end: it finds the answer in Developer Docs MCP, explains the steps, then actually does X using Chain MCP and/or SkillEngine, and verifies the result.
Requirements
01
Uses Docs MCP to plan, with sources cited, before acting.
02
Executes the plan with Chain MCP and/or SkillEngine; anything that moves funds is prepared for signature.
03
Verifies the outcome on chain and reports success or failure against the plan.
04
Works for at least 3 different "how do I…" requests.
05
Handles a request the docs don't cover by saying so instead of improvising.
Reviewers score against this list. Missing items can mean partial points.

### doc-search-cli
Easy
Developer Docs MCP
Doc-Search CLI
Build a small wrapper/tool on top of Developer Docs MCP (e.g., a doc-search CLI).
Points
50
Build on
ai.pharos.xyz
What you'll build
A small command-line tool (or similar lightweight wrapper) on top of Developer Docs MCP that lets a developer search Pharos docs from their terminal and get a concise, sourced answer.
Requirements
01
Accepts a natural-language question as input, e.g. `pharos-docs "how do I deploy a contract?"`.
02
Returns a concise answer plus links or references to the source doc sections.
03
Handles "no good answer found" gracefully instead of inventing one.
04
README with install and usage instructions and 3 example queries with outputs.
Reviewers score against this list. Missing items can mean partial points.

### docs-chain-mcp-agent
Medium
Composition
Docs MCP + Chain MCP Agent
Build an agent that uses Developer Docs MCP + Chain MCP together — explains a contract function, then calls it.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that explains and then acts. Given a contract function, it uses Developer Docs MCP to explain what the function does and its parameters, then calls it via Chain MCP and interprets the result.
Requirements
01
The explanation comes from Docs MCP, with sources referenced.
02
The agent then calls the same function on chain via Chain MCP.
03
Interprets the result in the context of the explanation.
04
Works for at least 2 different functions or contracts.
Reviewers score against this list. Missing items can mean partial points.

### docs-mcp-onboarding
Easy
Developer Docs MCP
Docs MCP Onboarding
Self-onboard into ai.pharos.xyz using only Developer Docs MCP — no external docs — and log where it broke down.
Points
50
Build on
ai.pharos.xyz
What you'll build
Onboard yourself onto ai.pharos.xyz using only Developer Docs MCP, with no external docs, search engines or community help, and write an honest log of the experience. This task is feedback: where did the docs get you unstuck, and where did they fail?
Requirements
01
A step-by-step log of what you tried to do, the questions you asked Docs MCP, and the answers you got.
02
At least 3 concrete gaps or breakdowns (wrong, missing, or confusing answers), each with the exact query.
03
A suggested fix for each gap: what the docs should have said.
04
Ends with what you managed to build or run by the end.
Reviewers score against this list. Missing items can mean partial points.

### dry-run-executor
Medium
SkillEngine
Dry-Run Executor
Simulates a transaction's outcome/cost before submitting for real.
Points
100
Build on
ai.pharos.xyz
What you'll build
A Skill that simulates a transaction before sending it, predicting whether it will succeed, what it will cost, and what it will change, so users and agents can make an informed go or no-go decision.
Requirements
01
Uses a call or gas estimation to simulate the transaction without broadcasting it.
02
Reports predicted success or revert, including the revert reason when available, and estimated gas cost.
03
Shows the expected outcome, e.g. balances or state before and after where possible.
04
Blocks execution automatically if the simulation fails.
Reviewers score against this list. Missing items can mean partial points.

### event-log-monitor
Easy
Chain MCP
Event/Log Monitor
Build a small monitor that watches for a specific on-chain event/log via Chain MCP.
Points
50
Build on
ai.pharos.xyz
What you'll build
A monitor that watches a Pharos contract for a specific event (e.g. `Transfer`, `Deposit`) and reports each new occurrence as it happens. It should keep running, not take a one-off snapshot.
Requirements
01
Uses Chain MCP log queries filtered by contract address and event signature.
02
Runs continuously (polling or block-by-block) and reports only new events, with no duplicates.
03
Decodes each event into readable fields (from, to, amount, tx hash, block).
04
Demonstrated catching at least one live or test event.
Reviewers score against this list. Missing items can mean partial points.

### gas-fee-optimizer
Medium
Trading / Monitoring
Gas Fee Optimizer
Monitors network gas price and times transaction submission for lowest cost.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that monitors network gas prices and times non-urgent transaction submissions for the lowest cost within a deadline you set.
Requirements
01
Tracks gas price over time and shows recent history.
02
Accepts a transaction with a deadline and holds it until gas is favorable or the deadline is reached.
03
Reports the actual gas paid compared with the price at request time.
04
Never misses the deadline. It submits at the deadline even if gas is high.
Reviewers score against this list. Missing items can mean partial points.

### invoice-to-payment-agent
Medium
Payments
Invoice-to-Payment Agent
Reads an invoice/request and prepares the matching payment.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that reads an invoice or payment request (text, PDF or structured data) and prepares the matching on-chain payment.
Requirements
01
Extracts payee, amount, token or currency, and reference from at least 2 invoice formats.
02
Flags mismatches or missing fields instead of guessing.
03
Produces a payment summary and an unsigned transaction that includes the invoice reference.
04
Includes a demo with sample invoices.
Reviewers score against this list. Missing items can mean partial points.

### liquidation-watchdog
Medium
DeFi / Portfolio
Liquidation Watchdog
Monitors a lending position and alerts before liquidation risk.
Points
100
Build on
ai.pharos.xyz
What you'll build
A monitor for a lending position that tracks its health factor and alerts the user before it gets close to liquidation, while there's still time to act.
Requirements
01
Reads the position's collateral, debt and health factor (or equivalent) from chain.
02
Configurable warning thresholds, e.g. warn at 1.3 and critical at 1.1.
03
Sends alerts through at least one channel: Telegram, Discord, email, or a console with timestamps.
04
Suggests a concrete action in each alert, e.g. "repay X or add Y collateral".
Reviewers score against this list. Missing items can mean partial points.

### multi-protocol-aggregator
Hard
Cross-tool / Advanced
Multi-Protocol Aggregator
Harbor-style agent extended across more than one protocol/vault.
Points
200
Build on
ai.pharos.xyz
What you'll build
A Harbor-style agent extended across more than one protocol or vault. It gives users one interface to query and act across several protocols, picking the best venue for each request.
Requirements
01
Integrates at least 2 protocols or vaults behind one interface.
02
Supports both queries (positions, rates) and actions (deposit or withdraw prepared for signature).
03
Routes each request to the best venue and explains why it chose it.
04
Handles one protocol being unavailable without breaking the others.
05
Includes an architecture write-up and a demo video, strongly encouraged for this tier.
Reviewers score against this list. Missing items can mean partial points.

### natural-language-payment-agent
Medium
Payments
Natural-Language Payment Agent
Turns "send 100 USDC to X" into a prepared transaction for signature (Harbor's action pattern, generalized).
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that turns a plain-language instruction like "send 100 USDC to alice.eth" into a fully prepared transaction for the user to review and sign. This generalizes Harbor's action pattern.
Requirements
01
Parses amount, token and recipient from free text, and asks a follow-up when anything is ambiguous.
02
Validates the request: recipient format, token contract, sufficient balance.
03
Shows a human-readable summary before producing the unsigned transaction.
04
Never signs or sends on its own. Output is an unsigned transaction or a wallet signing request.
Reviewers score against this list. Missing items can mean partial points.

### on-chain-alert-bot
Easy
Trading / Monitoring
On-Chain Alert Bot
Watches for a price threshold, large transfer, or contract call and notifies.
Points
50
Build on
ai.pharos.xyz
What you'll build
A bot that watches Pharos for a condition you choose, such as a price crossing a threshold, a large transfer, or a specific contract call, and notifies you when it happens.
Requirements
01
At least one configurable alert condition.
02
Delivers alerts to a real channel: Telegram, Discord or similar.
03
Each alert includes what happened, the value, and a tx or explorer link.
04
No repeat spam for the same event.
Reviewers score against this list. Missing items can mean partial points.

### policy-gatekeeper
Medium
SkillEngine
Policy Gatekeeper
Checks a requested action against spend limits/allowlists/time windows before executing.
Points
100
Build on
ai.pharos.xyz
What you'll build
A Skill that sits in front of an agent's actions and checks each requested action against a policy, such as spend limits, allowlisted addresses or contracts, and allowed time windows, before letting it through.
Requirements
01
A policy file or config with at least 3 rule types: spend limit, allowlist, time window.
02
Every request returns allow or deny with the specific rule that decided it.
03
Denied actions are never executed. Shows at least one deny per rule type.
04
Keeps an audit log of all decisions.
Reviewers score against this list. Missing items can mean partial points.

### portfolio-assistant
Hard
DeFi / Portfolio
Portfolio Assistant
Answers natural-language questions about a wallet's positions, balances, and yields across protocols (Harbor's query pattern, generalized).
Points
200
Build on
ai.pharos.xyz
What you'll build
A natural-language assistant that answers questions about a wallet's positions, balances and yields across multiple protocols, such as "what am I earning?", "where is my USDC?" or "what's my biggest position?". This generalizes Harbor's query pattern.
Requirements
01
Reads positions from at least 2 protocols or vaults, plus wallet token balances.
02
Answers at least 5 different natural-language question types correctly.
03
Shows numbers with sources: which contract and block each figure came from.
04
Says clearly when it doesn't know or can't read a protocol, rather than guessing.
05
Read-only: never initiates transactions.
Reviewers score against this list. Missing items can mean partial points.

### read-contract-state
Easy
Chain MCP
Read Contract State
Read a smart contract's state via Chain MCP.
Points
50
Build on
ai.pharos.xyz
What you'll build
A small agent or script that reads live state from a deployed Pharos contract through Chain MCP and presents it in plain language. Pick any public contract (a token, vault, or registry) and turn its raw storage and view calls into something a non-developer can read.
Requirements
01
Reads at least 3 different values from one contract via Chain MCP (e.g. name, totalSupply, owner, a balance).
02
Shows the contract address and the block number the data was read at.
03
Formats raw values for humans: token decimals applied, addresses labelled.
04
Includes a short README: which contract you chose, how to run it, sample output.
Reviewers score against this list. Missing items can mean partial points.

### recurring-payment-agent
Medium
Payments
Recurring Payment Agent
Handles a repeating on-chain payment (rent, subscription, payroll-style).
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that manages a repeating on-chain payment, such as rent, a subscription or payroll-style transfers, on a schedule.
Requirements
01
Supports a schedule (weekly or monthly) with amount, token and recipient.
02
Prepares each payment on time and tracks paid, pending and failed status.
03
Handles insufficient balance or a failed transaction without double-paying.
04
Shows a payment history and the next scheduled payment.
Reviewers score against this list. Missing items can mean partial points.

### saga-executor
Hard
SkillEngine
Saga Executor
A multi-step dependent workflow (approve → swap → deposit) with rollback/retry on failure.
Points
200
Build on
ai.pharos.xyz
What you'll build
A Skill that runs a multi-step, dependent on-chain workflow, such as approve → swap → deposit, where each step depends on the previous one succeeding. If a step fails, it retries or rolls back cleanly instead of leaving funds stranded halfway.
Requirements
01
At least 3 dependent steps, each verified (receipt checked) before the next starts.
02
A defined retry policy for transient failures, e.g. a gas spike or dropped transaction.
03
A defined compensation/rollback path when a step permanently fails, and a demo of it.
04
A state log showing exactly which step the saga is in at any time.
05
Shows one fully successful run and one forced-failure run with recovery.
Reviewers score against this list. Missing items can mean partial points.

### skill-chain-mcp-flow
Medium
Composition
Skill + Chain MCP Flow
Compose a SkillEngine skill with a Chain MCP call into one working agent flow.
Points
100
Build on
ai.pharos.xyz
What you'll build
One working agent flow where a SkillEngine Skill and Chain MCP work together: the Skill makes the decision and Chain MCP supplies live chain data (or the reverse). It shows the two tools composed, not used side by side.
Requirements
01
The Skill's output depends on live data fetched via Chain MCP in the same flow.
02
The flow runs end to end from a single user request.
03
A diagram or short write-up of the flow: what calls what, and in what order.
04
A demo run showing real data moving through both tools.
Reviewers score against this list. Missing items can mean partial points.

### trend-watcher
Hard
SkillEngine
Trend Watcher
Persists state across runs, acting only once a multi-observation trend condition is met.
Points
200
Build on
ai.pharos.xyz
What you'll build
A Skill with memory. It persists observations across runs and acts only once a trend is confirmed over multiple observations (e.g. "price down 3 checks in a row" or "TVL falling for 2 hours"), not on a single noisy reading.
Requirements
01
Stores state between runs: persistent storage, not just in-memory.
02
Trend rule needs at least 3 observations to trigger and is configurable.
03
Handles restarts without losing or duplicating history.
04
Shows the stored history and the exact moment the trend condition was met.
05
Demonstrates that a single spike does not trigger it.
Reviewers score against this list. Missing items can mean partial points.

### wallet-risk-checker
Medium
Compliance / Security
Wallet Risk Checker
Flags a wallet/contract's suspicious history before you transact with it.
Points
100
Build on
ai.pharos.xyz
What you'll build
A pre-transaction check that looks at a wallet's or contract's on-chain history and flags red flags before you interact with it.
Requirements
01
Checks at least 4 signals, e.g. contract age, verified code, interaction with flagged addresses, unusual approval patterns, freshly funded wallet.
02
Outputs a risk level (low, medium or high) with the specific reasons.
03
Explains each flag in plain language.
04
Demonstrated on at least 1 clean and 1 risky example.
Reviewers score against this list. Missing items can mean partial points.

### weekly-digest-agent
Medium
Support / Reporting
Weekly Digest Agent
Periodic summary of a wallet or protocol's activity.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that produces a periodic summary of a wallet's or protocol's activity, covering what changed, key numbers and notable events, and delivers it on a schedule.
Requirements
01
Runs on a schedule (weekly by default, configurable).
02
Covers key metrics with a comparison to the previous period.
03
Highlights the top 3 notable events of the period.
04
Delivers to a real channel (email, Telegram, Discord) or as a published page.
Reviewers score against this list. Missing items can mean partial points.

### whale-watching-agent
Medium
Trading / Monitoring
Whale-Watching Agent
Tracks a set of addresses and reports significant moves.
Points
100
Build on
ai.pharos.xyz
What you'll build
An agent that tracks a list of addresses and reports significant moves, such as large transfers, new positions or exits, with context on why each one matters.
Requirements
01
Tracks at least 5 configurable addresses.
02
A configurable "significant" threshold per token or in value terms.
03
Each report explains the move: what moved, how much, and where to (labelled where known).
04
Produces a summary view of recent activity across all watched addresses.
Reviewers score against this list. Missing items can mean partial points.

### yield-optimizer
Hard
DeFi / Portfolio
Yield Optimizer
Compares yields across vaults and recommends or executes a rebalance.
Points
200
Build on
ai.pharos.xyz
What you'll build
An agent that compares yields across vaults or pools, factors in costs, and recommends (or prepares) a rebalance when moving funds is actually worth it.
Requirements
01
Compares at least 3 yield sources using live on-chain data.
02
Accounts for gas, entry/exit fees, and a minimum holding period before recommending a move.
03
Outputs a clear recommendation with expected net gain, or "stay put" with the reason.
04
If executing: prepares transactions for user signature only. The agent never holds keys.
Reviewers score against this list. Missing items can mean partial points.

### threshold-guardian
Medium
SkillEngine
Threshold Guardian
Evaluates multiple on-chain conditions before deciding whether to fire an action at all.
Points
100
Build on
ai.pharos.xyz
What you'll build
A Skill that checks several on-chain conditions together before deciding whether to fire an action. Example: "only rebalance if price moved more than 3%, gas is below X, and the vault has more than Y liquidity". The point is decision logic, not just a single trigger.
Requirements
01
Evaluates at least 3 independent conditions read from chain.
02
Conditions and thresholds are configurable, not hard-coded.
03
Logs a clear decision trace each run: each condition's value, pass/fail, and the final decision.
04
Demonstrates both outcomes: one run where it fires and one where it holds.
Reviewers score against this list. Missing items can mean partial points.