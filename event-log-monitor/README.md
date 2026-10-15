# Event/Log Monitor

Watches one Pharos contract for one event and prints every new occurrence once, decoded, as it happens.
All chain access is Chain MCP: `get_block_number` for the chain head and `get_logs` filtered by contract
address and the event's topic0.

```bash
node event-log-monitor/monitor.mjs                       # USDC Transfer on Pharos mainnet, from the current block
node event-log-monitor/monitor.mjs --contract 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 \
  --event "Deposit(address indexed dst, uint256 wad)"    # WPROS wraps
node event-log-monitor/monitor.mjs --state state.json    # resumable; add --for 60 to stop after 60 s
```

| Option | Default |
|---|---|
| `--contract` | USDC `0xc879c018db60520f4355c26ed1a6d572cdac1815` |
| `--event` | `Transfer(address indexed from, address indexed to, uint256 value)` (any Solidity event signature) |
| `--interval` | 3 seconds between polls |
| `--from-block` | current head |
| `--state` | none; when set, the next block to scan is saved after every range |
| `--for` | run forever |

**How it avoids duplicates and gaps.** It scans contiguous ranges `[next, head]` (split into 1,000-block
chunks, the Chain MCP limit) and only advances `next` after a range is processed. With `--state`, `next` is
written to disk, so a restart resumes at the first unscanned block. Inside a run, each log is also keyed by
`txHash:logIndex`. Two transfers in the same transaction are two events and are both shown, with their log
numbers.

**Decoding.** The event signature is parsed with viem; topic0 is computed from it, never typed by hand.
Addresses are labelled where known, and token amounts get the token's decimals.

## Demo (real run, [`demo-run.txt`](demo-run.txt))

A 60-second run caught live USDC transfers on mainnet. It was then restarted with the same state file and
resumed at the next block (20,320,281) without repeating anything:

```
watching Transfer on USDC token (0xc879…1815) from block 20320232 via Chain MCP https://mcp.pharos.xyz/mcp
[block 20320232 16:09:29] Transfer  from=0x9365…b470  to=0x912c…f647  value=156.314935 USDC
    log #4  https://www.pharosscan.xyz/tx/0xb2201576924c65bb38cc19bd3eb2e7caea5331d33454af4656b67231b2925e6f
[block 20320256 16:09:56] Transfer  from=0x9365…b470  to=0x912c…f647  value=39.084494 USDC
    log #1  https://www.pharosscan.xyz/tx/0xb60db4c5b67b888e0f7a045faa0ff2c157dfd9d596a64e4617b48d5802a9db0e
stopped at block 20320280: 2 event(s)

# restarted with the same state file
watching Transfer on USDC token (0xc879…1815) from block 20320281 via Chain MCP https://mcp.pharos.xyz/mcp
[block 20320301 16:10:40] Transfer  from=0x9A6b…961D  to=0x768B…dE54  value=431.52 USDC
    log #0  https://www.pharosscan.xyz/tx/0x8bbd954c355b3fa534b6efdb708bfdf5fa7bdd5140ae6b88d84750446d757fb3
stopped at block 20320310: 1 event(s)
```

| Requirement | Where |
|---|---|
| Chain MCP log queries filtered by contract address and event signature | `get_logs` with `address` + `topics: [topic0]` |
| Runs continuously, reports only new events, no duplicates | polling loop, contiguous ranges, `--state`, `txHash:logIndex` set |
| Decodes each event (from, to, amount, tx hash, block) | `decodeEventLog`, output lines |
| Caught at least one live event | `demo-run.txt` (3 live USDC transfers across a restart) |
