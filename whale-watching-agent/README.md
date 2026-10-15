# Whale-Watching Agent

Tracks a list of addresses and reports their significant moves: what moved, how much, where to (labelled
where known), and why it matters. Then a summary across all watched addresses, including patterns that only
show up when you look at them together.

```bash
node whale-watching-agent/whales.mjs scan --hours 6                 # what happened in the window, + summary
node whale-watching-agent/whales.mjs watch --interval 15            # live: new blocks only
```

Config: [`whales.json`](whales.json): the watch list (label + address) and the thresholds, in USD (default
$1,000) and/or per token (e.g. `"WETH": 0.5`).

## How it works

1. **Find moves** with Chain MCP `get_logs`: the ERC-20 `Transfer` event on the known tokens (WPROS, USDC,
   WETH, LINK), filtered by *from ∈ watch list* and *to ∈ watch list* (topic OR-arrays, all tokens in one
   call): 2 queries per 1,000 blocks however many addresses are watched. Native PROS moves come from the
   explorer's per-address list (native value emits no log).
2. **Value** each move in USD with the Chainlink feeds on Pharos (PROS/USD, USDC/USD, ETH/USD, LINK/USD),
   read through Chain MCP. Keep only moves over a threshold.
3. **Explain** each significant move from its full receipt (`get_transaction` + `get_transaction_receipt`):
   every token the wallet sent or received in that transaction (share tokens and LP tokens included;
   unknown tokens get `symbol`/`decimals` through `eth_call`), and the contract it called. That separates
   a swap, a deposit into a vault (asset out, newly minted shares in), a withdrawal, a bridge-in (USDC
   minted to the wallet), a bridge-out (USDC burned), wraps, moves into or out of the DEX pool, and moves
   between watched wallets.
4. **Summarise** per address (moves, USD in, USD out, last move), the largest moves, and **patterns**:
   several watched wallets calling the same contract in the window.

## Real scan, 6 hours ([`scan-6h.txt`](scan-6h.txt))

The six wallets with the highest USDC/WPROS volume on Pharos in the previous 6 hours (chosen by volume from
`get_logs`, contracts excluded):

```
[2026-10-15 11:15] whale 2 (0xd094…8f44) received 96,603.73 USDC newly minted  (~$96,590)
    why it matters: Fresh USDC minted to this wallet: typically bridged in from another chain (Circle CCTP) or issued by Circle. New money arriving on Pharos.
[2026-10-15 11:18] whale 2 (0xd094…8f44) deposited 96,603.87 USDC into contract 0xd042…908a and received 93,793.07 APC3M (newly minted shares)  (~$96,590)
    why it matters: Capital going into a protocol or vault: it stays on Pharos, now earning or locked, and the wallet holds a claim (the share token) instead.
…
=== Summary: last 6 h, 10 significant move(s), threshold $1000, prices from Chainlink via Chain MCP ===
  Address                                      moves     in (USD)    out (USD)  last move
  whale 1 (0xbeed…6dba)                            2      249,965      249,965  deposited 250,000 USDC into contract 0xd042…908a …
  whale 2 (0xd094…8f44)                            2       96,590       96,590  deposited 96,603.87 USDC into contract 0xd042…908a …
  …
  whale 6 (0x1f35…c85c)                            0            0            0  —

  Pattern: 5 of 6 watched wallets called contract 0xd042…908a within 5.4 h, ~$518,131 in total; 5 of them had
  just received freshly minted USDC. Coordinated flow into one protocol: worth checking what that contract is.
```

Before step 3 existed, these deposits read as "sent 96,603 USDC to 0xf350…411f": the USDC goes to the
protocol's custody address and the share token isn't one of the watched tokens. Reading the receipt fixed
that. That is why every significant move is explained from its full receipt.

The live run ([`watch-run.txt`](watch-run.txt), 2 minutes) saw no move over the threshold from these six
wallets. It is included to show the mode runs; it caught nothing in that window.

| Requirement | Where |
|---|---|
| At least 5 configurable addresses | 6 in `whales.json` |
| Configurable "significant" threshold per token or in value terms | `thresholds.usd`, `thresholds.tokens` |
| Each report explains what moved, how much, where to, labelled | one line + "why it matters" + tx link per move |
| Summary view across all watched addresses | per-address table, largest moves, cross-wallet patterns |
