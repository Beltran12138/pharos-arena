# Read Contract State

Reads live state from one Pharos mainnet contract through Chain MCP and prints it for someone who does not
read hex.

```bash
node read-contract-state/read.mjs [contract] [holder]
# default: WPROS 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0, holder = the WPROS deployer
```

**Contract chosen:** WPROS (Wrapped PROS), because it has one property worth checking that a non-developer
can understand: is every WPROS backed by a PROS locked in the contract? The script reads the token supply
and the contract's native balance at the same block and says whether they match.

**What it reads, all at one block** (fetched first with `get_block_number`, then passed to every call):

| Value | Chain MCP tool |
|---|---|
| block number and its timestamp | `get_block_number`, `get_block` |
| contract bytecode size (proves it is a contract) | `get_code` |
| `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf(holder)` | `eth_call` |
| PROS locked in the contract | `get_balance` |

Raw values are formatted with the token's decimals and thousands separators; known addresses are labelled
(`WPROS deployer`, token names). Any ERC-20 on Pharos works as the first argument.

**Sample output:** [`sample-output.txt`](sample-output.txt)

```
Contract     Wrapped PROS (WPROS)  0x52c48d4213107b20bc583832b0d951fb9ca8f0b0
Read at      block 20,318,487  (2026-10-15T15:37:30.000Z)  via Chain MCP https://mcp.pharos.xyz/mcp
Total supply    23,287,142.0119 WPROS
PROS held       23,287,142.0119 PROS  (native balance of the contract)
In plain words: every WPROS in circulation is backed 1:1 by PROS locked in the contract.
```

| Requirement | Where |
|---|---|
| ≥3 values from one contract via Chain MCP | name, symbol, decimals, totalSupply, balanceOf, native balance, code |
| Contract address and block number shown | first three lines of the output |
| Human formatting: decimals applied, addresses labelled | `human()` and `label()` in `lib/pharos.mjs` |
| README: contract, how to run, sample output | this file |
