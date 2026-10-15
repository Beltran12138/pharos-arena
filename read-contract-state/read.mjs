#!/usr/bin/env node
// Read Contract State (Pharos Agent Arena, Easy): read live state from one Pharos mainnet contract
// through Chain MCP, pin every read to one block, and print it for a non-developer.
//
//   node read-contract-state/read.mjs [contract] [holder]
//
// Default contract: WPROS (Wrapped PROS). Every value comes from a Chain MCP tool call.
import { erc20Abi } from "viem";
import { connect, MCP_URL } from "../lib/mcp.mjs";
import { addrLink, human, label, read, NATIVE } from "../lib/pharos.mjs";

const contract = (process.argv[2] ?? "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0").toLowerCase();
// Default holder: the address that deployed WPROS (public, from the explorer's contract page).
const holder = (process.argv[3] ?? "0x7565f60988b83e577cb1a670ce577667311b11ae").toLowerCase();

const mcp = await connect();
try {
  const { blockNumber } = await mcp.call("get_block_number");
  const block = await mcp.call("get_block", { block: blockNumber });
  const at = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();

  const code = await mcp.call("get_code", { address: contract, block: blockNumber });
  const codeHex = typeof code === "string" ? code : code.code ?? code.result;
  if (!codeHex || codeHex === "0x") throw new Error(`${contract} has no contract code at block ${blockNumber}`);

  const [name, symbol, decimals, totalSupply, holderBal] = await Promise.all([
    read(mcp, contract, erc20Abi, "name", [], blockNumber),
    read(mcp, contract, erc20Abi, "symbol", [], blockNumber),
    read(mcp, contract, erc20Abi, "decimals", [], blockNumber),
    read(mcp, contract, erc20Abi, "totalSupply", [], blockNumber),
    read(mcp, contract, erc20Abi, "balanceOf", [holder], blockNumber),
  ]);
  const native = await mcp.call("get_balance", { address: contract, block: blockNumber });
  const backing = BigInt(native.balanceWei);

  const lines = [
    `Contract     ${name} (${symbol})  ${contract}`,
    `             ${addrLink(contract)}`,
    `Read at      block ${Number(blockNumber).toLocaleString("en-US")}  (${at})  via Chain MCP ${MCP_URL}`,
    `Code         ${(codeHex.length - 2) / 2} bytes deployed`,
    ``,
    `Token decimals  ${decimals}`,
    `Total supply    ${human(totalSupply, decimals, 4)} ${symbol}`,
    `${NATIVE} held       ${human(backing, 18, 4)} ${NATIVE}  (native balance of the contract)`,
    `Holder          ${label(holder)} (${holder}) holds ${human(holderBal, decimals, 6)} ${symbol}`,
  ];
  if (symbol === `W${NATIVE}`) {
    const diff = backing - totalSupply;
    lines.push(
      ``,
      diff === 0n
        ? `In plain words: every ${symbol} in circulation is backed 1:1 by ${NATIVE} locked in the contract.`
        : diff > 0n
          ? `In plain words: the contract holds ${human(diff, 18, 6)} ${NATIVE} more than the ${symbol} it has issued, so every ${symbol} is fully backed (the extra was sent in directly, not wrapped).`
          : `In plain words: the contract holds ${human(-diff, 18, 6)} ${NATIVE} LESS than the ${symbol} it has issued — it is under-backed.`,
    );
  }
  console.log(lines.join("\n"));
} finally {
  await mcp.close();
}
