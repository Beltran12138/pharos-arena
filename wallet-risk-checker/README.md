# Wallet Risk Checker

A pre-transaction check: before you send to, approve, or call an address on Pharos, look at its history and
flag what should make you pause. Output: a risk level (LOW / MEDIUM / HIGH) with each reason explained in
plain words.

```bash
node wallet-risk-checker/check.mjs 0x7d43e0e51550fe894ba71288eba90173ee9b180f
node wallet-risk-checker/check.mjs <address> --flagged my-flagged.json --json
```

## Signals

| Signal | For | Source | Level when it trips |
|---|---|---|---|
| On your flagged list | both | `flagged.json` (yours; ships empty) | HIGH |
| Transacted with a flagged address | both | recent counterparties (explorer) vs `flagged.json` | HIGH |
| Contract age | contract | creation time (explorer contract metadata) vs block time (Chain MCP `get_block`) | < 7 days HIGH, < 30 days MEDIUM |
| Verified source code | contract | explorer `is_verified` | not verified MEDIUM |
| Upgradeable proxy | contract | Chain MCP `get_storage_at` on the EIP-1967 implementation and admin slots | LOW (note) |
| Usage | contract | transaction count (explorer) | < 10 MEDIUM |
| Freshly funded / empty | wallet | first-seen time (explorer), nonce (Chain MCP `get_transaction_count`) | < 2 days HIGH, < 14 days MEDIUM, never used MEDIUM |
| Failed-transaction ratio | wallet | last 50 own transactions | > 30% MEDIUM |
| Unusual approvals | wallet | recent `approve` calls, decoded from Chain MCP `get_transaction`; unlimited, and to unverified contracts | unlimited to unverified MEDIUM, unlimited LOW |

Whether the address is a contract, and its balance, come from Chain MCP (`get_code`, `get_balance`).
Overall: **HIGH** if any signal is high or three are medium; **MEDIUM** if any is medium; otherwise
**LOW**. The flagged list is yours to fill (address → reason). The repo doesn't ship a blocklist, because a
list nobody can source is worse than none.

## Examples (real mainnet addresses, [`examples/`](examples/))

| Address | Result | Why |
|---|---|---|
| WPROS `0x52c4…f0b0` ([clean-contract-WPROS](examples/clean-contract-WPROS.txt)) | **LOW** | 271 days old, verified, not a proxy, >10,000 transactions |
| WPROS deployer `0x7565…11ae` ([clean-wallet-deployer](examples/clean-wallet-deployer.txt)) | **LOW** | first seen 281 days ago, 0/49 failed, no unlimited approvals |
| New contract `0x7d43…180f` ([risky-new-contract](examples/risky-new-contract.txt)) | **HIGH** | deployed 2.2 h before the check, source not verified, 2 transactions ever |
| DEX router `0x974d…9f35` ([router-unverified](examples/router-unverified.txt)) | **MEDIUM** | 80 days old and heavily used, but source not verified |
| Its deployer `0x4edf…b364` with a demo flagged list ([flagged-counterparty-demo](examples/flagged-counterparty-demo.txt)) | **HIGH** | transacted with an address on the flagged list (the list entry is marked as a demo, not an accusation) |

```
Risk check: 0x7d43…180f (0x7d43e0e51550fe894ba71288eba90173ee9b180f)
  contract, balance 0 PROS, block 20,322,773

RISK: HIGH  (Contract age, Verified source code, Usage)

  ✗ HIGH    Contract age: deployed 2.2 h ago by 0x4edf…b364
             Brand-new contracts have no track record. Most scam and rug-pull contracts are used within days of deployment.
  ! MEDIUM  Verified source code: source code NOT verified
             Nobody can easily read what this contract does. You'd be trusting bytecode you can't inspect.
  ! MEDIUM  Usage: 2 transaction(s) ever
             Almost nobody has used this contract yet.
```

**Limits.** "Risky" means "has red flags", not "is malicious": the new contract above may be perfectly
legitimate. The explorer shows at most 10,000 transactions per address, so very old busy addresses report
"more than N". Approval checks look at the last 50 transactions only.

| Requirement | Where |
|---|---|
| At least 4 signals | 9 (table above) |
| Risk level with the specific reasons | `RISK:` line lists the signals that tripped |
| Each flag explained in plain language | second line under each signal |
| At least 1 clean and 1 risky example | 2 clean, 2 high, 1 medium |
