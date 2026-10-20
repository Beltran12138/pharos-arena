# Invoice-to-Payment Agent

Reads an invoice — plain text, JSON, or an EIP-681 payment request — extracts payee, amount, token and
reference, flags what is missing or inconsistent instead of guessing, and prepares the matching unsigned
payment with the invoice reference in its calldata. It never signs or sends.

```bash
node invoice-to-payment/invoice.mjs samples/*.txt samples/*.json samples/*.uri --payer 0x… [--vendors vendors.json]
```

## Formats ([`extract.mjs`](extract.mjs))

| Format | Example | Read from |
|---|---|---|
| Plain text | [`01-design-studio.txt`](samples/01-design-studio.txt) | labelled lines (`Invoice No:`, `From:`, `Pay to:`, `Total due:`, `Due date:`, `Network:`/`Chain ID:`) and line items `desc  qty x price TOKEN = amount` |
| JSON | [`02-node-ops.json`](samples/02-node-ops.json) | common field names (`invoiceNumber`/`reference`, `seller.wallet`/`payee.address`, `lineItems`, `total`, `currency`, `chainId`) |
| EIP-681 URI | [`03-payment-request.uri`](samples/03-payment-request.uri) | `ethereum:<token>@1672/transfer?address=…&uint256=…&ref=…` (or native `?value=`); the token comes from the contract address |

## Flags (blocking unless marked note)

- missing: reference, payee address, amount, currency/token
- `USD` or any non-token currency: says which token is needed instead of assuming USDC
- line items that do not add up to the total, and quantity × price ≠ line amount
- a line item in a different currency from the total
- a chain other than Pharos mainnet (1672); no chain stated is a note
- **payee redirection**: the payee name is a vendor in [`vendors.json`](vendors.json) but the address is not the
  one on file (the usual invoice-fraud pattern); a payee not on file is a note
- the same reference already prepared (`prepared.jsonl`), so an invoice is not paid twice
- due date already past (note)
- then the on-chain checks shared with the other payment agents ([`lib/payment.mjs`](../lib/payment.mjs)): address
  format and checksum, token contract, balance, `estimate_gas` from the payer, gas

## Output

A payment summary (amount, token, payee with name, invoice reference, payer, network, max fee) and the unsigned
transaction in `out/<reference>.json`: legacy chain-1672 tx, RLP serialization, EIP-681 URI. The calldata carries
`INV:<reference>` after the ERC-20 transfer arguments (or as the data of a native transfer), so the payment can be
matched to the invoice on chain. Invoices prepared in one run get consecutive nonces, so they can all be signed.

## Demo with the sample invoices, 2026-10-20 ([`demo-run.txt`](demo-run.txt))

Payer `0x6Ea6…9071` (4.998 PROS, 0.0005 WPROS, no USDC).

| Invoice | Format | Result |
|---|---|---|
| 01 INV-2026-0142, 0.0003 WPROS, Lighthouse Design Studio | text | prepared, nonce 2, [`out/INV-2026-0142.json`](out/INV-2026-0142.json) |
| 02 HNO-7731, 0.0002 PROS, Harbor Node Ops | JSON | prepared, nonce 3, [`out/HNO-7731.json`](out/HNO-7731.json) |
| 03 LDS-REQ-88, 0.00015 WPROS | EIP-681 | prepared, nonce 4, [`out/LDS-REQ-88.json`](out/LDS-REQ-88.json) |
| 04 INV-2026-0139, 150 USDC | text | **flagged**: items add up to 160, not 150; 3 × 15 = 45, not 40; due date past |
| 05 HNO-7732, 250 USDC, "Harbor Node Ops" | JSON | **flagged**: Harbor Node Ops is on file with a different address |
| 06 "75 USD" e-mail | text | **flagged**: no reference; USD is not a token |
| 01 again | text | **flagged**: INV-2026-0142 was already prepared |

Check outside the agent: each prepared file's RLP was decoded (chain 1672, nonces 2/3/4), the memo read back from
the calldata (`INV:INV-2026-0142`, `INV:HNO-7731`, `INV:LDS-REQ-88`), and the transaction simulated with `eth_call`
straight against `rpc.pharos.xyz` (not MCP) from the payer: all three succeed, so the WPROS contract accepts the
reference appended to `transfer`. Nothing was signed or sent.

| Requirement | Where |
|---|---|
| Extracts payee, amount, token/currency, reference from ≥ 2 formats | three formats above; `extract()` |
| Flags mismatches or missing fields instead of guessing | `check()`; invoices 04–06 and the duplicate |
| Payment summary and an unsigned tx including the invoice reference | `invoice.mjs`; `out/*.json`, memo in calldata |
| Demo with sample invoices | [`samples/`](samples/), `demo-run.txt` |

Tests: `npm test` (`test/invoice.test.mjs`: the three formats, every flag above, duplicates).
