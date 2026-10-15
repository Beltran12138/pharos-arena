# Dry-Run Executor

A Skill ([`SKILL.md`](SKILL.md)) that simulates a Pharos transaction before it is sent: will it succeed,
what will it cost, what will it change. If the simulation fails, execution is blocked automatically.

```bash
node dry-run-executor/dryrun.mjs tx.json              # simulate only
node dry-run-executor/dryrun.mjs tx.json --execute    # simulate; sign + send only if it passed
```

## How it simulates (all through Chain MCP)

| Step | Tool |
|---|---|
| Success or revert, with the revert reason decoded (`Error(string)`, panics, custom errors) | `eth_call` at the latest block |
| Gas | `estimate_gas` |
| Fee = gas × current price | `get_gas_price` |
| Balances before, and after = before + predicted change | `get_balance`, `eth_call` `balanceOf` / `allowance` |
| Sender can pay value + fee | from the balance read above |

Predicted changes are worked out from the calldata: PROS value and fee for the sender, PROS for a plain
recipient, ERC-20 `transfer` (both sides), `approve` (allowance before → after, "unlimited" when it is
max uint), WPROS `deposit`/`withdraw` (PROS ↔ WPROS). For other calls it still predicts success, gas and
fee, and the sender's PROS. When a contract reverts without a reason, as WPROS does, and the prediction
shows a balance going below zero, it names that balance.

`--execute` re-runs the simulation, refuses on failure (exit 1, nothing signed), otherwise signs locally
(viem, `PRIVATE_KEY` must match `from`), sends, confirms the receipt via `get_transaction_receipt` and
reports gas used against the prediction.

## Examples (real simulations on mainnet, [`examples/`](examples/))

| Request | Prediction | Shows |
|---|---|---|
| [`1-send-pros`](examples/1-send-pros.txt) 0.0001 PROS to 0x…dEaD | succeeds, 21,000 gas, 0.00021 PROS | sender −0.00031, recipient +0.0001 |
| [`2-wrap`](examples/2-wrap.txt) wrap 0.5 PROS | succeeds, 36,735 gas | PROS −0.50036735, WPROS +0.5 |
| [`3-usdc-transfer`](examples/3-usdc-transfer.txt) 1 USDC | succeeds, 58,353 gas | USDC 2,075.29 → 2,074.29 and recipient +1 |
| [`4-usdc-too-much`](examples/4-usdc-too-much.txt) 1,000,000 USDC | **reverts**: "ERC20: transfer amount exceeds balance" | ⛔ blocked, exit 1 |
| [`5-unwrap-too-much`](examples/5-unwrap-too-much.txt) unwrap 1,000 WPROS | **reverts** without reason → "needs 1,000 WPROS but holds 4.3076" | ⛔ blocked, exit 1 |
| [`6-approve-unlimited`](examples/6-approve-unlimited.txt) unlimited USDC approval | succeeds, 71,897 gas | allowance 0 → unlimited |

```
Dry run at block 20,321,237 (Pharos mainnet, via Chain MCP)
  unwrap 1,000 WPROS while holding about 4.3
Prediction: REVERTS
  reason: The contract stopped it without giving a reason. Most likely cause: it needs 1,000 WPROS but WPROS deployer holds 4.3076.
⛔ BLOCKED: the simulation failed, so nothing was signed or sent.
```

The `from` addresses in the examples are public mainnet wallets chosen because they hold the assets; a
simulation needs no key and moves nothing.

| Requirement | Where |
|---|---|
| Simulates with a call / gas estimation, no broadcast | `eth_call` + `estimate_gas` |
| Predicted success or revert with reason, and gas cost | `Prediction:` lines |
| Expected outcome: balances before and after | `Balances before → after` |
| Blocks execution automatically if the simulation fails | `⛔ BLOCKED`, exit 1, `--execute` never signs |
