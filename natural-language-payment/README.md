# Natural-Language Payment Agent

"send 100 USDC to alice" → follow-up questions where the instruction is ambiguous → validation on Pharos
mainnet → a human-readable summary → an unsigned transaction and a wallet signing request. It never signs or
sends.

```bash
node natural-language-payment/pay.mjs "send 0.0002 WPROS to alice" --from 0x… [--contacts contacts.json]
```

Answers to questions and the final yes/no are read from stdin, one per line, so it works typed or piped.
Contact names come from [`contacts.json`](contacts.json).

## 1. Parse, and ask instead of guessing ([`parse.mjs`](parse.mjs))

Amount, token and recipient are extracted from the text with fixed rules. Anything that could mean two things
becomes a question:

| In the text | Question |
|---|---|
| `alice.eth` | there is no ENS on Pharos; "your contacts have alice = 0x…: is that the one?" |
| `ali` (matches alice and alicia) | which one? |
| `$0.5`, `usd`, `dollars` | USDC? |
| `ETH`, `PHRS` | WETH? / PROS? (PROS is the native token; PHRS is testnet) |
| `1.5k` | "is 1.5k 1500? give the exact number" |
| two amounts | which one? |
| a name not in contacts, a truncated `0x123`, no recipient / amount / token | asks for it |

An answer that does not fit (an unknown name, a non-number) is refused and asked once more.

## 2. Validate on chain ([`lib/payment.mjs`](../lib/payment.mjs), shared with the other payment agents)

All through Chain MCP: recipient format and EIP-55 checksum (mixed case that does not match is treated as a
typo), not the zero/burn address, not the token contract itself, whether it has contract code (a warning); the
token contract's on-chain `symbol`/`decimals` against the registry; the sender's token balance; `estimate_gas`
from the sender; PROS left for the fee. Amounts with more decimals than the token has are refused, not rounded.

## 3. Summary, then the unsigned transaction

The summary (amount, recipient with contact name, sender, network, max fee, memo, warnings) is shown and the
user is asked to confirm. Only then is the transaction prepared: a legacy chain-1672 transaction with the
sender's pending nonce and a gas limit 20% above the estimate, its RLP serialization (for wallets that sign raw)
and an EIP-681 URI, saved to `out/`. A memo (`for "INV-7"`) goes into the calldata.

## Demo on mainnet, 2026-10-20 ([`demo-run.txt`](demo-run.txt))

Sender `0x6Ea6…9071` (holds 4.998 PROS, 0.0005 WPROS, no USDC).

| # | Instruction | Questions asked → answers | Result |
|---|---|---|---|
| 1 | send 0.0002 WPROS to alice | – | summary → yes → [`out/…WPROS…json`](out/) |
| 2 | send 100 USDC to alice.eth | ENS → "yes" (contact alice) | **refused**: balance 0 USDC, simulation reverts "transfer amount exceeds balance" |
| 3 | pay ali $0.5 | alice or alicia → alicia; "$" = USDC? → PROS | summary → yes → [`out/…PROS…json`](out/) |
| 4 | send 1.5k PROS to 0x6649228a90BEF932… | 1.5k = 1500? → 1500 | **refused**: the address's mixed-case checksum is wrong |
| 5 | send 0.1 WPROS and 0.2 WPROS to bob | which amount? → 0.0001 | summary → **no** → nothing prepared |

Check of the two prepared transactions outside the agent: each file's RLP was decoded (chain 1672, nonce 2) and
simulated with `eth_call` straight against `rpc.pharos.xyz` (not MCP) from the sender: both succeed, the WPROS
transfer returning `true`. Neither was signed or sent.

| Requirement | Where |
|---|---|
| Parses amount, token, recipient; asks when ambiguous | `parse()` questions; demo 2–5 |
| Validates recipient format, token contract, balance | `validate()`; demo 2 and 4 refused |
| Human-readable summary before the unsigned transaction | `pay.mjs`: summary → confirm → prepare |
| Never signs or sends | no key is read anywhere; output is an unsigned tx + EIP-681 URI |

Tests: `npm test` (`test/nl-payment.test.mjs`: every ambiguity above, answers, exact amounts, calldata and
memo, serialized tx round trip).
