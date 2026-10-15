// Diagnosis paths that are hard to find live on mainnet, driven through a fake Chain MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, erc20Abi, toFunctionSelector } from "viem";
import { diagnose, kindOf, parseRevert } from "../dapp-support-agent/diagnose.mjs";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const ME = "0x00000000000000000000000000000000000000aa";
const YOU = "0x00000000000000000000000000000000000000bb";
const H = "0x" + "ab".repeat(32);

function fakeMcp({ input, to = USDC, gas = 100000n, gasUsed = 40000n, revertData, balance = 0n, allowance = 0n }) {
  return {
    async call(name, args) {
      if (name === "get_transaction")
        return { from: ME, to, input, value: "0x0", gas: "0x" + gas.toString(16), gasPrice: "0x2540be400", blockTimestamp: "0x1" };
      if (name === "get_transaction_receipt")
        return { status: "0x0", blockNumber: "0x64", gasUsed: "0x" + gasUsed.toString(16), effectiveGasPrice: "0x2540be400", transactionIndex: "0x0" };
      if (name === "eth_call") {
        const sel = args.transaction.data.slice(0, 10);
        if (sel === toFunctionSelector("function balanceOf(address)"))
          return { result: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: balance }) };
        if (sel === toFunctionSelector("function allowance(address,address)"))
          return { result: encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: allowance }) };
        throw new Error(`eth_call: ${JSON.stringify({ error: { message: "execution reverted", code: 3, data: revertData } })}`);
      }
      if (name === "get_code") return { code: "0x6080" };
      throw new Error(`unexpected ${name}`);
    },
  };
}

const errorString = (s) => "0x08c379a0" + encodeAbiParameters([{ type: "string" }], [s]).slice(2);

test("ERC-20 transfer above balance: says how much was tried vs held", async () => {
  const input = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [YOU, 5_000_000n] });
  const d = await diagnose(fakeMcp({ input, revertData: errorString("ERC20: transfer amount exceeds balance"), balance: 1_250_000n }), H);
  assert.equal(d.kind, "balance");
  assert.match(d.why, /send 5 USDC, but the wallet held 1\.25 USDC/);
});

test("ERC-20 transferFrom above allowance: names the approved amount", async () => {
  const input = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [YOU, ME, 3_000_000n] });
  const custom = toFunctionSelector("function ERC20InsufficientAllowance(address,uint256,uint256)") + "00".repeat(96);
  const d = await diagnose(fakeMcp({ input, revertData: custom, balance: 10_000_000n, allowance: 1_000_000n }), H);
  assert.equal(d.kind, "allowance");
  assert.match(d.why, /only approved for 1/);
});

test("out of gas: used the whole limit", async () => {
  const d = await diagnose(fakeMcp({ input: "0x12345678", to: "0x00000000000000000000000000000000000000cc", gas: 50000n, gasUsed: 50000n }), H);
  assert.equal(d.kind, "out-of-gas");
});

test("revert decoding: Error(string), Panic, custom error, bare message", () => {
  assert.equal(parseRevert(`x ${JSON.stringify({ error: { data: errorString("Transaction too old") } })}`).kind, "deadline");
  const panic = "0x4e487b71" + encodeAbiParameters([{ type: "uint256" }], [0x12n]).slice(2);
  assert.match(parseRevert(`x ${JSON.stringify({ error: { data: panic } })}`).text, /divided by zero/);
  const own = toFunctionSelector("function OwnableUnauthorizedAccount(address)") + "00".repeat(32);
  assert.equal(parseRevert(`x ${JSON.stringify({ error: { data: own } })}`).kind, "permission");
  assert.equal(parseRevert("eth_call: execution reverted: Pausable: paused").kind, "paused");
});

test("reason strings map to the right kind", () => {
  assert.equal(kindOf("Min return not reached"), "slippage");
  assert.equal(kindOf("InsufficientOutputAmount(uint256,uint256,uint256)"), "slippage");
  assert.equal(kindOf("UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT"), "slippage");
  assert.equal(kindOf("ERC20: insufficient allowance"), "allowance");
  assert.equal(kindOf("BC"), "unknown");
});
