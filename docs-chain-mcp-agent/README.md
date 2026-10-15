# Docs MCP + Chain MCP Agent

Explain, then act, then interpret. Given a contract and a function, the agent:

1. asks **Developer Docs MCP** (`askQuestion`) what the function does, its parameters and its return value,
   and prints the answer with its sources;
2. calls the function through **Chain MCP** (`eth_call`) at a pinned block;
3. interprets the result: first deterministic checks against what the docs said (scale by the decimals the
   docs state, turn timestamps into an age, compare ids with the ones the docs list, after fetching the
   cited page with `getPage`), then asks Docs MCP about this concrete result; finally it tries, on the same
   contract, every no-argument function the docs pointed to and flags any that revert.

```bash
node docs-chain-mcp-agent/agent.mjs \
  --contract 0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466 \
  --name "Chainlink PROS/USD price feed proxy" \
  --fn "latestAnswer() returns (int256)"
```

If the docs don't cover the function, it says so and does not interpret beyond the raw value. If the
function reverts on chain although the docs describe it, it reports the disagreement.

## Runs (real, [`runs/`](runs/))

| # | Contract · function | On chain | Interpretation |
|---|---|---|---|
| 1 | PROS/USD proxy · `latestAnswer()` | `597103475382835000` | docs say 18 decimals → **$0.5971 per PROS**; docs add that freshness must be checked separately |
| 2 | PROS/USD proxy · `getFeedId()` | `0x0003f73a…e246` | **matches** the feed ID in the docs table for this proxy; it identifies the feed, it is not a price |
| 3 | ETH/USD proxy · `latestTimestamp()` | `1792081595` | DON observation time, 472 s before the block, inside the 1-hour heartbeat |
| 4 | MultiCall3 · `getBasefee()` | `0` | docs don't document this method → **no interpretation** (exit 3) |
| 5 | PROS/USD proxy · `latestReportTimestamp()` | **reverts** | the docs page recommends it, the proxy doesn't implement it → **docs and contract disagree** (exit 4) |

Excerpt of run 1:

```
## 1. What the docs say about latestAnswer on Chainlink PROS/USD price feed proxy
  `latestAnswer()` reads the latest cached PROS/USD price from the proxy. It takes no parameters and returns an `int256`.
  The feed uses 18 decimals, so interpret the returned integer as: price in USD per PROS = returned value ÷ 10^18
  Sources: Chainlink Push Engine Feeds <https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe>; …

## 2. Calling it on chain (Chain MCP eth_call)
  block 20,321,652 (2026-10-15T16:32:44.000Z)
  latestAnswer() → 597103475382835000

## 3. What the result means
  Checked against the explanation:
  - The docs say values use 18 decimals, so 597103475382835000 = 0.59710348.
  … In plain terms, the feed reported about $0.5971 USD for 1 PROS.
```

Run 5 is a real finding: *Chainlink Push Engine Feeds* says to use `latestReportTimestamp` on the proxy,
but the deployed proxies only answer `latestTimestamp()` (the function in the page's own interface
listing). The agent caught it by acting on the explanation instead of trusting it.

**Note on run 4.** `getBasefee()` returns `block.basefee`; under `eth_call` without a gas price, nodes run
the call with a zero base fee, so 0 is expected here and does not mean the network's base fee is 0
(`get_block` shows 10 gwei). The agent doesn't claim either, because the docs don't cover it.

| Requirement | Where |
|---|---|
| Explanation from Docs MCP, with sources | step 1, `Sources:` lines |
| Then calls the same function via Chain MCP | step 2 |
| Interprets the result in the context of the explanation | step 3: decimals, timestamp age, id match, Docs MCP on the concrete value |
| At least 2 different functions or contracts | 5 runs, 3 contracts, 5 functions |
