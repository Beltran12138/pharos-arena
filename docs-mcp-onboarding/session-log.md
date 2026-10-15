# Docs MCP onboarding session (raw log)

Endpoint: https://docs.pharos.xyz/~gitbook/mcp  
Run: 2026-10-15T16:39:46.813Z  
Goal passed to askQuestion: "I am a developer onboarding onto ai.pharos.xyz to build agents on Pharos using only the docs."

## 1. Find out what ai.pharos.xyz is

**askQuestion**: `What is ai.pharos.xyz and what can a developer do there?` (20.2 s)

> The docs don’t identify **ai.pharos.xyz** by name. They describe **Anvita Flow** as Pharos’s AI-agent platform: it hosts Pharos Skills as discoverable, callable Service Agents. The documented Developer Console is [flow.anvita.xyz/service-agents](https://flow.anvita.xyz/service-agents).
> 
> As a developer, you can:
> 
> * **Build a Pharos Skill** that teaches an AI agent specific on-chain tasks, such as querying balances, sending transactions, or deploying contracts. See the [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide).
> * **Upload and publish it as a Service Agent.** Configure its runtime, test it in a debug session, and create a public Agent Card. Published agents can be discovered and called by other agents through the Marketplace. See [Publish Service Agent](/tooling-and-infrastructure/overview/publish-skill-af).
> * **Connect an agent to Pharos chain data and operations** through the Pharos MCP server. It exposes tools for blocks, balances, transactions, contract reads, logs, gas estimates, and broadcasting signed transactions. See [Pharos MCP](/tooling-and-infrastructure/mcp).
> 
> In short: **Skills define what your agent does; Anvita Flow hosts and publishes it; MCP provides a way to access Pharos chain tools.**
> 
> # Sources
> 
> - [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
> - [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
> - [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [Goldsky](https://docs.pharos.xyz/tooling-and-infrastructure/indexing/goldsky)
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)
> - [Vision & Mission](https://docs.pharos.xyz/introduction/vision-and-mission)
> - [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
> - [Encyclopedia](https://docs.pharos.xyz/introduction/encyclopedia)
> - [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
> - [Anvita Flow](https://docs.pharos.xyz/tooling-and-infrastructure/overview)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)

## 2. Connect the chain tools

**askQuestion**: `How do I connect the Pharos Chain MCP server to my agent? What is its endpoint URL?` (12.7 s)

> Connect your agent to the hosted Pharos MCP server using **Streamable HTTP**:
> 
> ```json
> {
>   "mcpServers": {
>     "pharos": {
>       "type": "http",
>       "url": "https://mcp.pharos.xyz/mcp"
>     }
>   }
> }
> ```
> 
> The endpoint is **`https://mcp.pharos.xyz/mcp`**. It’s public and requires no API key. The server provides Pharos chain tools; see [Pharos MCP](/tooling-and-infrastructure/mcp) for setup details and available tools.
> 
> If your client only supports stdio, configure `mcp-remote` as a bridge to the same endpoint.
> 
> # Sources
> 
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [Cross Chain Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)
> - [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)
> - [Rust](https://docs.pharos.xyz/developer-guide/rust)
> - [Call EVM From WASM](https://docs.pharos.xyz/developer-guide/interoperability/call-evm-from-wasm)
> - [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp)
> - [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)

## 3. Connect the docs tools

**askQuestion**: `Is there an MCP server for the Pharos developer docs, and what URL do I add to my MCP client?` (10.0 s)

> The docs don’t list a docs-specific MCP server. They do provide a hosted **Pharos MCP server** for chain data and onchain operations at:
> 
> `https://mcp.pharos.xyz/mcp`
> 
> Add it to an HTTP-compatible MCP client with `"type": "http"` and that URL. No API key is required. See [Pharos MCP](/tooling-and-infrastructure/mcp) for setup details.
> 
> # Sources
> 
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)
> - [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
> - [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
> - [Pacific Mainnet](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)
> - [Encyclopedia](https://docs.pharos.xyz/introduction/encyclopedia)
> - [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
> - [Supra](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/supra)
> - [Solidity](https://docs.pharos.xyz/resources/solidity)
> - [Chainlink Data Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-ds)

## 4. Learn the Chain MCP surface

**askQuestion**: `Which tools does the Pharos Chain MCP expose, and what rate limits apply to the hosted endpoint?` (12.3 s)

> The hosted [Pharos MCP](/tooling-and-infrastructure/mcp) exposes these tools:
> 
> * **Chain and blocks:** `get_chain_info`, `get_block_number`, `get_block`, `get_gas_price`
> * **Accounts and transactions:** `get_balance`, `get_transaction_count`, `get_transaction`, `get_transaction_receipt`
> * **Contract reads and logs:** `eth_call`, `estimate_gas`, `get_code`, `get_storage_at`, `get_logs`
> * **Broadcasting:** `send_raw_transaction` — relays an already-signed transaction
> 
> The hosted endpoint is `https://mcp.pharos.xyz/mcp`. It requires no authentication and allows **120 requests per minute per IP**. Rate-limit errors return `429`; back off according to the `Retry-After` header.
> 
> Separately, `get_logs` allows a maximum range of **1,000 blocks per call**.
> 
> # Sources
> 
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp)
> - [Cross Chain Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [JSON-RPC API Methods](https://docs.pharos.xyz/api-and-sdk/json-rpc-methods)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)
> - [Why Pharos](https://docs.pharos.xyz/introduction/why-pharos)
> - [Enable AutoPruning in Pharos Node](https://docs.pharos.xyz/enable-pruning-in-pharos-node)
> - [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
> - [LayerZero](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/layerzero)

## 5. Know what the hosted MCP can't do

**askQuestion**: `Can the hosted Pharos Chain MCP send transactions, or is it read-only?` (17.8 s)

> The hosted Pharos Chain MCP is **not read-only**: it exposes `send_raw_transaction` to broadcast an already-signed transaction.
> 
> Signing happens in your wallet or script. The MCP server relays the signed bytes and never needs your private key. The hosted endpoint is public and requires no API key. See [Pharos MCP](/tooling-and-infrastructure/mcp).
> 
> # Sources
> 
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [Cross Chain Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain)
> - [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp)
> - [RPC Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/rpc)
> - [Hardhat](https://docs.pharos.xyz/developer-guide/hardhat)
> - [Foundry](https://docs.pharos.xyz/developer-guide/foundry)
> - [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)

## 6. Install the skill engine

**askQuestion**: `How do I install and use the Pharos Skill Engine with an AI agent?` (22.0 s)

> The Pharos Skill Engine is a **tooling and instruction package**, not an SDK or API. Give your AI agent access to its folder; the agent reads `SKILL.md`, then follows the relevant instructions in `references/` and runs Foundry commands.
> 
> 1. **Unpack the Skill Engine** and open its directory:
> 
>    ```bash
>    unzip pharos-skill-engine-0.1.0.zip
>    cd pharos-skill-engine-0.1.0
>    ```
> 
>    The folder should contain `SKILL.md`, `assets/`, and `references/`.
> 2. **Install Foundry**, which provides the required `cast` and `forge` commands:
> 
>    ```bash
>    curl -L https://foundry.paradigm.xyz | bash
>    source ~/.zshenv && foundryup
>    cast --version
>    forge --version
>    ```
> 3. **Configure the wallet and network** in the shell where the agent will run:
> 
>    ```bash
>    export PRIVATE_KEY=0xYOUR_PRIVATE_KEY
>    export RPC=https://atlantic.dplabs-internal.com
>    export DEPLOYER=$(cast wallet address --private-key $PRIVATE_KEY)
>    ```
> 
>    Keep the private key out of prompts, scripts, and version control. Foundry does not automatically read it; write commands must pass `--private-key $PRIVATE_KEY`.
> 4. **Start your AI agent in the Skill Engine directory** and ask for an operation, such as “Check my wallet balance” or “Deploy an ERC20 token.” The agent uses the capability index to find instructions and execute the appropriate command. For writes, it must complete the documented pre-checks first.
> 
> For a Claude Code walkthrough, see the [Piggy Bank Tutorial](/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide). The [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) covers setup, supported operations, and command references.
> 
> # Sources
> 
> - [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
> - [Anvita Flow](https://docs.pharos.xyz/tooling-and-infrastructure/overview)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
> - [Using Binary](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-binary-deployment)
> - [Using Docker](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-docker-deployment)
> - [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)
> - [Validator Node Deployment](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)

## 7. Get gas

**askQuestion**: `How do I get PROS for gas on Pharos mainnet?` (13.5 s)

> **PROS is Pharos mainnet’s gas token.** You can get it through [port.pharos.xyz/get-pros](https://port.pharos.xyz/get-pros), using one of these options:
> 
> * **Already have crypto:** Use Halliday to send crypto from another wallet, or withdraw directly from an exchange. For exchange withdrawals, select **Pharos** as the network.
> * **Paying with fiat:** Use Halliday’s cash option or the **Alchemy Pay** button for a card or bank checkout.
> * **Need a wallet:** Use the **TopNod** option to create or open a wallet, then buy or deposit PROS.
> 
> Before confirming, check that the destination address is yours. Never share your seed phrase or private key. Afterward, verify your balance on [Pharos Scan](https://www.pharosscan.xyz).
> 
> For wallet network setup, use [Pacific Mainnet](/getting-started/network/pacific-mainnet): chain ID `1672`, RPC `https://rpc.pharos.xyz`, ticker `PROS`. See [Get PROS Gas](/getting-started/get-pros-gas) for the purchase steps and balance checks.
> 
> # Sources
> 
> - [Pacific Mainnet](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)
> - [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [Gas Model](https://docs.pharos.xyz/getting-started/gas-model)
> - [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
> - [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [About Pharos](https://docs.pharos.xyz/introduction/readme)
> - [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
> - [Chainlink Push Engine Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe)

## 8. Read a price on chain

**askQuestion**: `How do I read the PROS/USD price and its timestamp on chain on Pharos mainnet?` (18.3 s)

> Read the Pacific Mainnet PROS/USD proxy at `0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466` using the Pharos RPC, `https://rpc.pharos.xyz` (chain ID `1672`).
> 
> With Foundry’s `cast`, make two read-only calls:
> 
> ```bash
> cast call 0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466 \
>   "latestAnswer()(int256)" --rpc-url https://rpc.pharos.xyz
> 
> cast call 0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466 \
>   "latestTimestamp()(uint256)" --rpc-url https://rpc.pharos.xyz
> ```
> 
> `latestAnswer()` returns the price scaled to **18 decimals**; divide by `10^18` to get the human-readable value. `latestTimestamp()` returns the latest report’s **observation timestamp**. It reflects when the price was observed, not when its transaction was included on-chain. Check its freshness against the current block timestamp and enforce an application-appropriate staleness limit.
> 
> See [Chainlink Push Engine Feeds](/tooling-and-infrastructure/oracles/chainlink-pe) for the feed interface and deployment addresses, and [Pacific Mainnet](/getting-started/network/pacific-mainnet) for network details.
> 
> # Sources
> 
> - [Pacific Mainnet](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)
> - [Oracle](https://docs.pharos.xyz/tooling-and-infrastructure/oracles)
> - [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
> - [Chainlink Push Engine Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe)
> - [Supra](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/supra)
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [Cross Chain Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain)
> - [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
> - [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)

## 9. Find a testnet token

**askQuestion**: `What is the USDC token address on the Atlantic testnet?` (11.0 s)

> The USDC contract address on Atlantic testnet is `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B`. It uses 6 decimals. See the [Token Registry](/getting-started/token-registry).
> 
> # Sources
> 
> - [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
> - [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
> - [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)
> - [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
> - [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)
> - [Write Your First NFT](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-nft)
> - [Chainlink Push Engine Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe)
> - [Rapid Node Initialization(Testnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-testnet)
> - [Write Your First NFT](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-nft)
> - [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp)

## 10. Find the builder program

**askQuestion**: `What is Pharos Season of AI or the Pharos Agent Arena, and how do I submit a build?` (28.7 s)

> I cannot find information about **Pharos Season of AI** or the **Pharos Agent Arena** in the docs, including their rules, deadlines, or submission process.
> 
> The documented route for publishing an agent is through **Anvita Flow**. It hosts a Pharos Skill as a discoverable Service Agent; the docs don’t confirm that this is the same as submitting to the Agent Arena.
> 
> To publish a Service Agent:
> 
> 1. Build a Pharos Skill package with an uppercase `SKILL.md`. Its frontmatter needs `name` and `description`, and `name` must match the package folder exactly.
> 2. Zip the **whole skill folder**, then register at [Anvita Flow](https://flow.anvita.xyz/home) and open the [Developer Console](https://flow.anvita.xyz/service-agents).
> 3. Select **Create A Managed Service Agent**, upload the ZIP, configure the service strategy and runtime, and complete a successful debug run.
> 4. Fill out the Agent Card and submit for review. After approval, the agent is published. The list should show **Published / Running**.
> 
> See the [Publish Service Agent](/tooling-and-infrastructure/overview/publish-skill-af) for package requirements and the full workflow, and the [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) for building and extending Skills.
> 
> # Sources
> 
> - [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
> - [Anvita Flow](https://docs.pharos.xyz/tooling-and-infrastructure/overview)
> - [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
> - [Write Your First dApp](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)
> - [Goldsky](https://docs.pharos.xyz/tooling-and-infrastructure/indexing/goldsky)
> - [Write Your First dApp](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-dapp)
> - [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
> - [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
> - [x402](https://docs.pharos.xyz/developer-guide/x402)
> - [Using Binary](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-binary-deployment)
> - [Network](https://docs.pharos.xyz/getting-started/network)
> - [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
> - [Indexer](https://docs.pharos.xyz/tooling-and-infrastructure/indexing)

## 11. Search instead of ask

**searchDocumentation**: `deploy a contract` (2.9 s)

1 result(s):

- Write Your First Uniswap Contract — https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-uniswap-contract

## 12. Search instead of ask

**searchDocumentation**: `How do I deploy a contract on Pharos?` (1.4 s)

1 result(s):

- Validator Node Deployment — https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment
