# Docs MCP Onboarding

Onboarding onto ai.pharos.xyz using **only** the Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`):
no web search, no community help. Where an answer could be checked, it was checked on chain through Chain
MCP, not against another document.

- Raw log, every query and answer verbatim: [`session-log.md`](session-log.md) (produced by
  [`session.mjs`](session.mjs), which replays the session).
- Rule kept: Docs MCP `sendFeedback` was never called; the feedback is this file.

## Step-by-step log

| # | What I tried to do | Query (Docs MCP tool) | What I got | Verdict |
|---|---|---|---|---|
| 1 | Learn what ai.pharos.xyz is | `askQuestion` "What is ai.pharos.xyz and what can a developer do there?" | "The docs don't identify ai.pharos.xyz by name"; describes Anvita Flow, Skills, Pharos MCP instead | ❌ gap 1 |
| 2 | Connect chain tools | `askQuestion` "How do I connect the Pharos Chain MCP server to my agent? What is its endpoint URL?" | `https://mcp.pharos.xyz/mcp`, Streamable HTTP, no key, JSON config | ✅ worked first try (verified: `initialize` 200, 14 tools) |
| 3 | Connect docs tools | `askQuestion` "Is there an MCP server for the Pharos developer docs, and what URL do I add to my MCP client?" | "The docs don't list a docs-specific MCP server", then points to the Chain MCP | ❌ gap 2 |
| 4 | Learn the Chain MCP surface | `askQuestion` "Which tools does the Pharos Chain MCP expose, and what rate limits apply to the hosted endpoint?" | 14 tools by group, 120 req/min/IP, 429 + `Retry-After`, `get_logs` ≤ 1,000 blocks | ✅ matches `listTools` and the error text when I asked for 1,001 blocks |
| 5 | Know whether the hosted MCP can broadcast | `askQuestion` "Can the hosted Pharos Chain MCP send transactions, or is it read-only?" | "not read-only: it exposes `send_raw_transaction`" | ⚠️ answer right, page ambiguous (gap 3) |
| 6 | Install the Skill Engine | `askQuestion` "How do I install and use the Pharos Skill Engine with an AI agent?" | `unzip pharos-skill-engine-0.1.0.zip`, install Foundry, export `PRIVATE_KEY`, run the agent in the folder | ❌ gap 4 |
| 7 | Get gas | `askQuestion` "How do I get PROS for gas on Pharos mainnet?" | port.pharos.xyz/get-pros: Halliday, exchange withdrawal, Alchemy Pay, TopNod; chain 1672, RPC | ✅ |
| 8 | Read a price on chain | `askQuestion` "How do I read the PROS/USD price and its timestamp on chain on Pharos mainnet?" | proxy `0x371E…5466`, `latestAnswer()` (18 decimals) and `latestTimestamp()` | ✅ both calls work (`0.5971`, observation time). The page itself says otherwise elsewhere (gap 5) |
| 9 | Find the testnet USDC | `askQuestion` "What is the USDC token address on the Atlantic testnet?" | `0xcfC8…Fc8B`, 6 decimals | ⚠️ gap 6 |
| 10 | Find the builder program | `askQuestion` "What is Pharos Season of AI or the Pharos Agent Arena, and how do I submit a build?" | "I cannot find information about Pharos Season of AI or the Pharos Agent Arena", then the Anvita publish flow | ❌ gap 7 (honest answer, missing page) |
| 11 | Search instead of asking | `searchDocumentation` "deploy a contract" | 1 result: *Write Your First Uniswap Contract* | ⚠️ gap 8 |
| 12 | Same, as a question | `searchDocumentation` "How do I deploy a contract on Pharos?" | 1 result: *Validator Node Deployment* | ❌ gap 8 |

`askQuestion` took 10–29 s per question; `searchDocumentation` 1–3 s.

## Gaps, with the exact query and a suggested fix

**1. The portal everybody is sent to is not in the docs.**
Query: `askQuestion("What is ai.pharos.xyz and what can a developer do there?")` →
*"The docs don't identify ai.pharos.xyz by name."*
Fix: an **AI.PHAROS** page: what the portal is, its four modes (General Chat, Pharos Docs MCP, Pharos Official
Skill, Pharos MCP), and how each maps to the Anvita Flow, Skill Engine and MCP pages.

**2. The docs don't know they have an MCP server.**
Query: `askQuestion("Is there an MCP server for the Pharos developer docs, and what URL do I add to my MCP client?")` →
*"The docs don't list a docs-specific MCP server."* This session was running on it.
Fix: on the *Pharos MCP* page, a "Docs MCP" section: URL `https://docs.pharos.xyz/~gitbook/mcp`, tools
(`searchDocumentation`, `getPage`, `askQuestion`, `sendFeedback`), the same JSON config snippet as the Chain MCP.

**3. Whether the hosted MCP broadcasts is only implied.**
Query: `askQuestion("Can the hosted Pharos Chain MCP send transactions, or is it read-only?")` →
*"not read-only: it exposes `send_raw_transaction`."* The *Pharos MCP* page lists `ENABLE_SEND_RAW_TRANSACTION`
with default `false` and says broadcasting is *"disabled by default in self-hosted deployments"*, which a
reader can take to mean the hosted one is read-only too. Checked: a malformed raw transaction sent to the
hosted endpoint comes back with the node's `TX_OVER_SIZE`, so the hosted server does forward. (Before this
task I had read the opposite in the pharos-mcp GitHub README, which is outside the docs.)
Fix: one explicit sentence for the hosted endpoint: "`send_raw_transaction` is enabled on
`mcp.pharos.xyz`; it only relays transactions you signed."

**4. The Skill Engine install starts from a file the docs never link.**
Query: `askQuestion("How do I install and use the Pharos Skill Engine with an AI agent?")` → step 1 is
`unzip pharos-skill-engine-0.1.0.zip`. `getPage` on *Pharos Skill Engine* (20,919 characters) contains no
download link and no repository link. Step 2's `source ~/.zshenv && foundryup` assumes zsh.
Fix: link the zip or the repository next to step 1; give the bash and Windows (Git Bash / WSL) variants of
the Foundry step.

**5. The Chainlink page recommends a function the proxies don't have.**
Query (from the Docs+Chain agent, run 5):
`askQuestion("On Pharos, what does the function latestReportTimestamp() do on the Chainlink PROS/USD price feed proxy (0x371E…5466)? …")`
→ the docs describe it ("reads the observation time for the latest PROS/USD report"). On chain,
`latestReportTimestamp()` on that proxy **reverts**; `latestTimestamp()`, from the page's own interface
listing, works.
Fix: in the *Chainlink Push Engine Feeds* note, replace "`latestReportTimestamp` on the proxy" with
`latestTimestamp()`, and give the full signature of `latestAnswerTimestampForFeed` on the cache contract.

**6. Two "USDC" contracts on Atlantic testnet.**
Query: `askQuestion("What is the USDC token address on the Atlantic testnet?")` → `0xcfC8330f…Fc8B`.
The Skill Engine package that the docs tell you to install ships `assets/tokens.json` with Atlantic USDC
`0xE0BE08c7…4ec8`. Both are live contracts and both return `symbol() = "USDC"` on Atlantic. An agent using
the Skill Engine will pay with a different token than a developer reading the docs.
Fix: one canonical Atlantic USDC in the Token Registry, the other marked deprecated, and `tokens.json` synced.

**7. The builder program isn't documented.**
Query: `askQuestion("What is Pharos Season of AI or the Pharos Agent Arena, and how do I submit a build?")` →
*"I cannot find information about Pharos Season of AI or the Pharos Agent Arena."* The answer is honest
and then offers the Anvita publish flow, adding that it can't confirm this is the arena submission.
Fix: a short page linking the arena, the task board and what a valid proof link is.

**8. Search returns one result, and for a plain question the wrong one.**
Query: `searchDocumentation("How do I deploy a contract on Pharos?")` → 1 result, *Validator Node
Deployment*. `searchDocumentation("deploy a contract")` → 1 result, *Write Your First Uniswap Contract*.
*Write Your First Token*, the page `askQuestion` actually uses for deployment, is not returned.
Fix: return the top 5 with scores, and index the "Write Your First …" tutorials for "deploy".

**Also noticed:** every `askQuestion` answer appends 10–13 "sources", most unrelated to the question (for
step 1: *Node Debugging & Configuration*, *Pharos Network Snapshots*, *Goldsky*). The links inside the
answer body are the reliable ones; `doc-search-cli` ranks those first for that reason.

## What I built or ran by the end

Starting from the endpoint in step 2 and the feed and network facts in steps 4, 7 and 8:

- a Chain MCP + Docs MCP client ([`lib/mcp.mjs`](../lib/mcp.mjs)),
- [`read-contract-state`](../read-contract-state/): WPROS supply vs locked PROS at a pinned block,
- [`doc-search-cli`](../doc-search-cli/): this session's search problems turned into a terminal tool that
  says "not covered" instead of guessing,
- [`docs-chain-mcp-agent`](../docs-chain-mcp-agent/): explains a function from these docs, calls it, and
  found gap 5 by doing so,
- [`threshold-guardian`](../threshold-guardian/): uses the PROS/USD feed from step 8.

| Requirement | Where |
|---|---|
| Step-by-step log: what I tried, the queries, the answers | table above; verbatim in `session-log.md` |
| ≥3 concrete gaps, each with the exact query | gaps 1–8 |
| A suggested fix for each gap | "Fix:" under each gap |
| Ends with what was built or run | last section |
