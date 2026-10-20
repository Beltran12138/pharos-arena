# Doc-Grounded Builder

"How do I do X on Pharos?" end to end: the agent asks **Developer Docs MCP**, explains the answer with its sources,
does X through **Chain MCP**, and verifies the result through a second channel. It does only what the docs back:
if they don't document X, it says so and does nothing.

```bash
node doc-grounded-builder/builder.mjs "How do I check how much USDC 0x… holds on Pharos mainnet?"
node doc-grounded-builder/builder.mjs --from 0x… "How do I send 0.01 PROS to 0x… on Pharos mainnet?"   # prepares, never signs
node --env-file=.env doc-grounded-builder/sign.mjs doc-grounded-builder/out/<id>.json                 # the owner signs
node doc-grounded-builder/builder.mjs verify doc-grounded-builder/out/<id>.json                       # result vs the plan
```

## How it works

1. **Plan, from the docs.** `askQuestion` with the request. The steps are not written by the agent: they are the
   commands the docs answer itself gives — `cast call`, `cast send`, `cast code`, or a JSON-RPC request in a curl body
   ([`plan.mjs`](plan.mjs) parses them; shell variables and line continuations are resolved). Placeholders
   (`<ADDRESS>`, `<TRANSACTION_HASH>`) are filled from the user's request only; a missing one stops the step.
2. **Check every fact against the docs pages.** `askQuestion` is itself generated text, so it is not a source on its
   own. The agent fetches the cited pages with `getPage` (and, for a fact not found there, `searchDocumentation` and
   the pages it returns) and labels each address, function, method and endpoint in a step:
   `page` (with the URL) · `standard` (an ERC-20 function on a token the docs list) · `request` (the user's input) ·
   `answer only` · `disclaimed` (the answer itself says the docs don't confirm it). A step with an `answer only` or
   `disclaimed` fact does not run. A function counts only on a page that also lists **that** contract.
3. **Execute through Chain MCP.** Reads run (`eth_call`, `get_transaction_receipt`, `get_code`). Anything that
   moves funds is validated (recipient, balance, `estimate_gas` from the sender, fee) and prepared as an unsigned
   transaction in `out/`; the owner signs it with [`sign.mjs`](sign.mjs). The agent has no key.
4. **Verify against the plan, through a second channel**: the same request sent directly to `https://rpc.pharos.xyz`,
   the endpoint the docs name, at the same block. Units the answer claims ("18 decimals") are checked against the
   pages and against `decimals()` on chain. After signing, `verify` checks the receipt status, chain, sender,
   recipient, value, nonce and the recipient's balance change between the two blocks.
5. **Not covered → say so.** No command in the answer, or a request to *do* something (wrap, stake, bridge, send…)
   with no grounded command that does it: `NOT COVERED`, quoting what the docs answer says is missing. Read-only checks
   the answer suggests may still run, labeled "for information only"; nothing is prepared.

## Runs on mainnet, 2026-10-20 ([`runs/`](runs/))

| # | Request | Outcome |
|---|---|---|
| 1 | [check how much USDC `0x1857…4efb` holds](runs/1-usdc-balance.txt) | **DONE.** `balanceOf` on USDC `0xc879…1815` (Token Registry; `balanceOf` = EIP-20) → 1,321,516.426712 USDC; same through the direct RPC; 6 decimals stated on *x402 Pacific Mainnet* and equal to `decimals()` on chain |
| 2 | [read the current PROS/USD price](runs/2-pros-usd-price.txt) | **DONE.** `latestAnswer()` on the PROS/USD proxy `0x371E…5466` (*Chainlink Push Engine Feeds*) → $0.6172; 18 decimals stated on that page (its table) and on chain |
| 3 | [check whether tx `0xa57f…9720` succeeded](runs/3-tx-status.txt) | **DONE.** The docs' `eth_getTransactionReceipt` (*JSON-RPC API Methods*) via Chain MCP → status `0x1`, block 20,735,903; the docs' curl request sent as-is agrees on status, block hash, gas and logs |
| 4 | [send 0.01 PROS to `0x6649…04c5`](runs/4-send-pros.txt) | **PREPARED → signed by the owner → VERIFIED**, see below |
| 5 | [wrap 0.001 PROS into WPROS](runs/5-wrap-pros.txt) | **NOT COVERED.** The docs list WPROS's address but no wrapping method; no command in the answer, nothing ran |
| 5b | [the same, replaying an earlier answer that improvised `cast send WPROS "deposit()"`](runs/5b-wrap-pros-improvised-answer-replayed.txt) | **NOT COVERED.** `deposit` is `disclaimed`: the same answer says the docs "don't confirm that `deposit()` is the right call" |
| 6 | [stake PROS with a validator as a delegator](runs/6-delegate-stake.txt) | **NOT COVERED.** The docs document validator registration, not delegation; nothing ran |
| 7 | [bridge 1 USDC to Ethereum with Circle CCTP](runs/7-cctp-bridge.txt) | **NOT COVERED.** The Pharos-side CCTP contracts are documented, the Ethereum domain and the `depositForBurn` arguments are not |

Run 4, the one that moves funds. The docs answer gave `cast send 0x6649… --value 0.01ether --rpc-url
https://rpc.pharos.xyz`; recipient from the request, endpoint on *Pacific Mainnet*. The agent checked the recipient,
the sender's 4.996 PROS, `estimate_gas` (21,000) and the fee, and wrote an unsigned legacy transaction (chain 1672,
nonce 7) to [`out/`](out/). The owner signed it with `sign.mjs`:
[`0xaaec0f84…3dd3`](https://www.pharosscan.xyz/tx/0xaaec0f848079a0d1c8a7401959919b42240088c7f2bc7c4b1073e5586db33dd3).
[`verify`](runs/4b-send-pros-verify.txt): status `0x1` on both channels, chain, sender, recipient, value 0.01 PROS,
nonce 7, and the recipient's balance 0.0002035 → 0.0102035 PROS between blocks 20,748,616 and 20,748,617 →
**SUCCESS against the plan**.

## What building this turned up

- **The docs answer improvises, and says so in passing.** One answer to "wrap PROS" gave a runnable
  `cast send … "deposit()"` and, two sentences later, "Do not treat that method signature as docs-confirmed". The first
  version of the grounding check accepted it, because `deposit(` appears in the docs — on the *Piggy Bank tutorial*,
  a different contract ([`runs/5-wrap-pros-before-fix.txt`](runs/5-wrap-pros-before-fix.txt), where it was stopped only
  because contract calls with value are not prepared). Fixed: a function must be on a page that lists the contract,
  and a function the answer disclaims is refused. The real answer is a test fixture
  ([`test/fixtures/docs-answer-wrap-improvised.md`](../test/fixtures/docs-answer-wrap-improvised.md)).
- **The agent's own wording has to be grounded too.** The first receipt run printed `(docs: "0x1" success, "0x0"
  failure)` — written by me, not the docs; the docs answer had just said they "do not define status-code meanings",
  and the *JSON-RPC API Methods* page shows `"status": "0x1"` only inside an example. It now says that 0x1 = success
  is the Ethereum receipt standard (EIP-658), not a Pharos docs statement.
- **Docs gaps found**, each stated by the docs answer and confirmed on the pages: the mainnet Token Registry lists no
  decimals (USDC's 6 is on the x402 page); no WPROS interface; no delegation flow; no Pharos→Ethereum CCTP example;
  receipt status codes are not defined.
- `getPage` returns escaped markdown (`eth\_getCode`); facts are matched after unescaping.

| Requirement | Where |
|---|---|
| Uses Docs MCP to plan, with sources cited, before acting | step 1: the answer, its sources, every fact with the page it is on |
| Executes with Chain MCP; anything that moves funds prepared for signature | step 3: `eth_call` / `get_transaction_receipt` / `get_code`; run 4 prepared unsigned, signed by the owner with `sign.mjs` |
| Verifies on chain and reports success or failure against the plan | step 4: second channel at the same block; `verify` checks the sent tx field by field |
| At least 3 different "how do I…" requests | 4 done (balance, price, tx status, send) |
| Says so when the docs don't cover a request | runs 5, 5b, 6, 7: `NOT COVERED`, quoting the gap, nothing prepared |

Limits: requests whose answer contains a runnable command; contract calls that move funds (`cast send` with a
function) are not prepared, only plain transfers. Docs MCP answers vary between runs; each run log keeps the answer it
acted on, and `--answer <file>` replays a saved one.

Tests: `npm test` (`test/doc-grounded.test.mjs`: command parsing, shell variables, placeholders, grounding including
the other-contract page and the disclaimed `deposit()`, decimals claims).
