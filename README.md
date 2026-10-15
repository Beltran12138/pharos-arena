# pharos-arena

Three builds for the [Pharos Agent Arena](https://pharos-agent-arena.vercel.app/) (Season of AI). Every chain
read goes through the hosted **Pharos Chain MCP** server (`https://mcp.pharos.xyz/mcp`, read-only, no key);
nothing here talks to a Pharos RPC directly except `exec` broadcasting a transaction the user signed locally
(the hosted MCP disables `send_raw_transaction`).

| Build | Arena task | What it does |
|---|---|---|
| [`read-contract-state/`](read-contract-state/) | Read Contract State (Easy) | Reads a Pharos mainnet contract at one pinned block and explains it in plain words |
| [`policy-gatekeeper/`](policy-gatekeeper/) | Policy Gatekeeper (Medium) | A Skill that allows or denies each on-chain action against spend limits, allowlists and time windows, with a hash-chained audit log |
| [`audit-log-agent/`](audit-log-agent/) | Audit-Log Agent (Medium) | A plain-language activity report for a wallet over a date range, exported as Markdown and CSV |

```bash
npm install
node read-contract-state/read.mjs                                   # WPROS by default
node policy-gatekeeper/gatekeeper.mjs check policy-gatekeeper/scenario.json
node audit-log-agent/report.mjs --wallet 0x… --from 2026-10-01 --to 2026-10-15
npm test
```

Node 20+. Chain MCP tools used: `get_block_number`, `get_block`, `get_code`, `get_balance`, `eth_call`,
`estimate_gas`, `get_gas_price`, `get_transaction`, `get_transaction_receipt`. The hosted endpoint allows
120 requests per minute per IP; the client backs off on 429.

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
