# dApp Support Agent

Give it a failed transaction hash; it explains in plain words why it failed and what to do next.

```bash
node dapp-support-agent/explain.mjs 0x135b2b4b…     # human answer
node dapp-support-agent/explain.mjs 0x135b2b4b… --json
```

## How it works

All chain access is Chain MCP.

1. `get_transaction` + `get_transaction_receipt`: sender, target, value, calldata, gas limit, gas used,
   status, block. Not found → explains that a transaction rejected by the wallet was never broadcast.
   Succeeded → says so.
2. **Out of gas** if it used ≥99% of its limit. A plain PROS send with 21,000 gas to a contract is called
   out separately (the contract cannot receive PROS that way); `get_code` confirms the target is a contract.
3. **Replay** with `eth_call` (same sender, calldata, value, gas) against the state at the end of the
   previous block, to recover the revert data. Decoded as `Error(string)`, `Panic(uint256)` (with the panic
   explained), known OpenZeppelin/DEX custom errors (selectors computed from signatures), or, for other
   custom errors, a best-effort lookup in the public openchain signature database (used only when it
   returns exactly one match).
4. **Same-block failure:** if the replay *succeeds*, the transaction was fine in itself. Something earlier
   in its own block changed the state it relied on (a price, a balance), so retrying usually works.
5. **Token transfers:** for ERC-20 `transfer`/`transferFrom` on known tokens, `eth_call` `balanceOf` and
   `allowance` at the previous block say exactly how much was tried versus held or approved.
6. The reason is mapped to a type (balance, allowance, slippage, deadline, permission, paused, signature,
   already-done, liquidity, out-of-gas, no-receive, same-block, panic, unknown); each type has a plain fix.

## Demonstrated on real mainnet failures ([`examples/`](examples/))

| Example | Failure type | What it says |
|---|---|---|
| [`slippage.txt`](examples/slippage.txt) | slippage (revert string) | "The contract stopped it with the message 'Min return not reached'" → get a fresh quote, or raise slippage slightly |
| [`slippage-custom-error.txt`](examples/slippage-custom-error.txt) | slippage (custom error) | unnamed selector `0x911bb2c9` resolved to `InsufficientOutputAmount` |
| [`no-receive.txt`](examples/no-receive.txt) | out of gas / contract can't receive | "It sent 0.01 PROS to a contract with only 21000 gas… send it to a wallet address, or use the contract's deposit function" |
| [`same-block.txt`](examples/same-block.txt) | state changed earlier in the block | replay succeeds → nothing wrong with the transaction, retry with a fresh quote |
| [`not-found.txt`](examples/not-found.txt) | never broadcast | explains no fee was paid |

```
What happened: the transaction from 0xf7c8…3d62 to 0x974d…9f35 failed in block 20,051,313. Nothing it tried
to do took effect, but the network fee of 0.002716 PROS was still paid.

Why: The contract stopped it with the message "Min return not reached".

What you can do: The price moved between when you got your quote and when the trade ran, beyond the
slippage you allowed. Get a fresh quote and retry, or raise slippage tolerance slightly if the market is
moving fast.
```

Insufficient balance, insufficient allowance, out-of-gas, panics and revert-string mapping are covered by
`test/dapp-support.test.mjs` with a fake Chain MCP, because recent mainnet failures were mostly bot trades.

**Limits.** The replay uses the state at the end of the previous block, not the exact position inside the
block, so a failure caused by an earlier transaction in the same block shows up as "same-block" rather
than with its revert reason. Some bots revert with private codes (e.g. `"BC"`, `"SPL0"`); those are
reported as "rejected without a known reason".

| Requirement | Where |
|---|---|
| Tx hash in; transaction and receipt via Chain MCP | `diagnose()` steps 1–2 |
| Identifies the cause: revert reason, out of gas, balance/allowance… | steps 2–5 |
| Explains without jargon, suggests a fix | `ADVICE`, `render()` |
| At least 3 different failure types | slippage, no-receive/out-of-gas, same-block (+ tests for balance and allowance) |
