The [Token Registry](/getting-started/token-registry) lists Pharos mainnet WPROS at **`0x52c48d4213107b20bc583832b0d951fb9ca8f0b0`**. Mainnet uses chain ID `1672` and RPC `https://rpc.pharos.xyz` ([Pacific Mainnet](/getting-started/network/pacific-mainnet)).

The docs **do not document WPROS’s ABI or wrapping method**, so they don’t confirm that `deposit()` is the right call. If you independently verify the contract ABI includes a payable `deposit()` function, this Cast command sends `0.001 PROS` (`10^15` wei):

```bash
cast send 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 \
  "deposit()" \
  --value 0.001ether \
  --private-key "$PRIVATE_KEY" \
  --rpc-url https://rpc.pharos.xyz
```

**Do not treat that method signature as docs-confirmed.** The docs also don’t specify WPROS decimals, expected output, or wrapping events. They provide the token address, but not enough contract-interface detail to guarantee a runnable wrap transaction.

