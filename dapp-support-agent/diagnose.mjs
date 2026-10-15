// Failed-transaction diagnosis for the dApp Support Agent (CLI: explain.mjs).
// Everything comes from Chain MCP: get_transaction and get_transaction_receipt for the facts, eth_call to
// replay the transaction against the state just before its block (to recover the revert reason), get_block
// to see what else ran in that block, and eth_call balanceOf/allowance for token transfers.
import { decodeAbiParameters, decodeFunctionData, erc20Abi, toFunctionSelector, formatEther } from "viem";
import { NATIVE, TOKENS, human, label, read, txLink } from "../lib/pharos.mjs";

// Custom errors worth naming. Selectors are computed from the signatures.
const CUSTOM_ERRORS = Object.fromEntries(
  [
    ["ERC20InsufficientBalance(address,uint256,uint256)", "balance"],
    ["ERC20InsufficientAllowance(address,uint256,uint256)", "allowance"],
    ["ERC20InvalidReceiver(address)", "receiver"],
    ["OwnableUnauthorizedAccount(address)", "permission"],
    ["AccessControlUnauthorizedAccount(address,bytes32)", "permission"],
    ["SafeERC20FailedOperation(address)", "token-call"],
    ["EnforcedPause()", "paused"],
    ["ExpectedPause()", "paused"],
    ["InvalidSignature()", "signature"],
    ["Expired()", "deadline"],
    ["TooLittleReceived()", "slippage"],
    ["TooMuchRequested()", "slippage"],
  ].map(([sig, kind]) => [toFunctionSelector(`function ${sig}`), { sig, kind }]),
);

const PANICS = {
  0x01: "an internal assertion failed",
  0x11: "a number overflowed or underflowed (for example, subtracting more than was there)",
  0x12: "the contract divided by zero",
  0x21: "an invalid enum value was used",
  0x31: "it tried to remove an item from an empty list",
  0x32: "it read past the end of a list",
  0x41: "it ran out of memory",
  0x51: "it called an uninitialised function",
};

// Revert strings → kind. Ordered: first match wins.
const STRING_KINDS = [
  [/allowance|TRANSFER_FROM_FAILED|STF\b|not approved|approve/i, "allowance"],
  [/exceeds balance|insufficient (token )?balance|balance too low|INSUFFICIENT_BALANCE|transfer amount exceeds/i, "balance"],
  [/min(imum)? return|insufficient ?output|too little received|INSUFFICIENT_OUTPUT_AMOUNT|INSUFFICIENT_.*_AMOUNT|slippage|too much requested|price impact|amountOutMin|Return amount is not enough/i, "slippage"],
  [/expired|too old|deadline|EXPIRED/i, "deadline"],
  [/owner|unauthori[sz]ed|not allowed|forbidden|access|only /i, "permission"],
  [/paused/i, "paused"],
  [/signature/i, "signature"],
  [/already (claimed|minted|exists|used)|nonce/i, "already-done"],
  [/insufficient liquidity|INSUFFICIENT_LIQUIDITY|K\b/i, "liquidity"],
];

const ADVICE = {
  balance: "You tried to move more than the wallet held. Check the balance, then retry with an amount you actually have.",
  allowance: "The contract was not allowed to move that much of your token. Approve the token for this contract (at least the amount you are sending), then retry.",
  slippage: "The price moved between when you got your quote and when the trade ran, beyond the slippage you allowed. Get a fresh quote and retry, or raise slippage tolerance slightly if the market is moving fast.",
  deadline: "The transaction was signed with a deadline that passed before it was included. Sign it again; it will get a new deadline.",
  permission: "This function is restricted to a particular account (for example the contract owner), and your wallet is not that account. Use the right account or ask the project.",
  paused: "The contract is paused by its operators, so this action is temporarily disabled. Wait for the project to unpause it.",
  signature: "A signature included in the transaction was rejected. Re-sign the request in your wallet and retry.",
  "already-done": "This action was already done (claimed, minted or used) and can only be done once.",
  liquidity: "The pool did not have enough liquidity for this trade. Try a smaller amount or another pool.",
  receiver: "The token refused the recipient address. Double-check the address you are sending to.",
  "token-call": "A token transfer inside the transaction failed, usually because of balance or approval. Check both, then retry.",
  "out-of-gas": "The transaction ran out of gas before finishing. Retry with a higher gas limit (your wallet's estimate plus about 30%).",
  "no-receive": "You sent PROS to a contract that does not accept plain transfers. Send it to a wallet address, or use the contract's own deposit function.",
  "same-block": "Nothing was wrong with the transaction itself: replayed against the state before its block, it succeeds. Other transactions in the same block changed the state first (typically a price or a balance). Retrying usually works; for trades, get a fresh quote.",
  panic: "The contract hit an internal error with these inputs. Check the amounts you entered; if they look right, report it to the project with this transaction link.",
  unknown: "The contract rejected the transaction without saying why. Check the amounts and approvals, then contact the project with this transaction link.",
};

export async function diagnose(mcp, hash) {
  let tx, rc;
  try {
    [tx, rc] = await Promise.all([mcp.call("get_transaction", { hash }), mcp.call("get_transaction_receipt", { hash })]);
  } catch (e) {
    return { hash, found: false, error: e.message };
  }
  if (!tx || !rc || typeof tx !== "object") return { hash, found: false };
  const d = {
    hash,
    found: true,
    link: txLink(hash),
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    block: Number(BigInt(rc.blockNumber)),
    gasLimit: BigInt(tx.gas),
    gasUsed: BigInt(rc.gasUsed),
    fee: BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? tx.gasPrice),
    value: BigInt(tx.value),
    selector: tx.input.slice(0, 10),
    ok: rc.status === "0x1",
  };
  if (d.ok) return d;

  // 1. Out of gas: it used (almost) all of its limit.
  if (d.gasUsed * 100n >= d.gasLimit * 99n) {
    const code = d.to ? await mcp.call("get_code", { address: d.to, block: String(d.block) }) : null;
    const isContract = code && (code.code ?? code.result ?? code) !== "0x";
    if (isContract && d.value > 0n && tx.input === "0x" && d.gasLimit <= 23000n) {
      d.kind = "no-receive";
      d.why = `It sent ${formatEther(d.value)} ${NATIVE} to a contract with only ${d.gasLimit} gas, the amount for a wallet-to-wallet transfer. The contract has no simple way to receive ${NATIVE}, so the transfer stopped.`;
    } else {
      d.kind = "out-of-gas";
      d.why = `It used ${d.gasUsed} of its ${d.gasLimit} gas limit, all of it, and stopped before finishing.`;
    }
    return d;
  }

  // 2. Replay just before its block to get the revert reason.
  const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas };
  let revert = null;
  try {
    await mcp.call("eth_call", { transaction: call, block: String(d.block - 1) });
  } catch (e) {
    revert = parseRevert(e.message);
  }
  if (!revert) {
    const blk = await mcp.call("get_block", { block: String(d.block), includeTransactions: true });
    const before = (blk.transactions ?? []).filter(
      (t) => typeof t === "object" && Number(BigInt(t.transactionIndex)) < Number(BigInt(rc.transactionIndex)) && t.to?.toLowerCase() === d.to,
    );
    d.kind = "same-block";
    d.why = `Replayed against the state just before block ${d.block}, it succeeds. ${before.length ? `${before.length} other transaction(s) to the same contract ran before it in that block` : "Transactions earlier in the same block"} changed the state it depended on.`;
    return d;
  }
  if (revert.selector) {
    const name = await lookupError(revert.selector);
    if (name) {
      revert.raw = name;
      revert.text = `The contract rejected it with the error ${name.split("(")[0]}.`;
      revert.kind = kindOf(name);
    }
  }
  d.revert = revert;
  d.kind = revert.kind;
  d.why = revert.text;

  // 3. Token transfers: say exactly how much was tried versus what was there.
  const token = d.to && TOKENS[d.to];
  if (token && (d.kind === "balance" || d.kind === "allowance" || d.kind === "token-call" || d.kind === "unknown")) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.input });
      const at = d.block - 1;
      if (functionName === "transfer") {
        const bal = await read(mcp, d.to, erc20Abi, "balanceOf", [d.from], at);
        if (bal < args[1]) {
          d.kind = "balance";
          d.why = `It tried to send ${human(args[1], token.decimals)} ${token.symbol}, but the wallet held ${human(bal, token.decimals)} ${token.symbol}.`;
        }
      } else if (functionName === "transferFrom") {
        const [bal, allow] = await Promise.all([
          read(mcp, d.to, erc20Abi, "balanceOf", [args[0]], at),
          read(mcp, d.to, erc20Abi, "allowance", [args[0], d.from], at),
        ]);
        if (allow < args[2]) {
          d.kind = "allowance";
          d.why = `It tried to move ${human(args[2], token.decimals)} ${token.symbol} from ${label(args[0])}, but was only approved for ${human(allow, token.decimals)}.`;
        } else if (bal < args[2]) {
          d.kind = "balance";
          d.why = `It tried to move ${human(args[2], token.decimals)} ${token.symbol}, but ${label(args[0])} held ${human(bal, token.decimals)}.`;
        }
      }
    } catch {
      // not a plain ERC-20 call
    }
  }
  return d;
}

export function parseRevert(message) {
  const json = message.slice(message.indexOf("{"));
  let msg = message;
  let data = null;
  try {
    const e = JSON.parse(json).error;
    msg = e.message ?? message;
    data = e.data ?? null;
  } catch {
    // keep raw message
  }
  if (data && data.startsWith("0x08c379a0")) {
    const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
    return { raw: reason, text: `The contract stopped it with the message "${reason}".`, kind: kindOf(reason) };
  }
  if (data && data.startsWith("0x4e487b71")) {
    const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${data.slice(10)}`);
    return { raw: `Panic(0x${code.toString(16)})`, text: `The contract crashed: ${PANICS[Number(code)] ?? `panic code 0x${code.toString(16)}`}.`, kind: Number(code) === 0x11 ? "balance" : "panic" };
  }
  if (data && data.length >= 10 && CUSTOM_ERRORS[data.slice(0, 10)]) {
    const e = CUSTOM_ERRORS[data.slice(0, 10)];
    return { raw: e.sig, text: `The contract rejected it with the error ${e.sig.split("(")[0]}.`, kind: e.kind };
  }
  if (data && data.length >= 10) {
    const selector = data.slice(0, 10);
    return { raw: selector, selector: selector === "0x00000000" ? null : selector, text: `The contract rejected it with an unnamed error (${selector}).`, kind: "unknown" };
  }
  const m = msg.match(/execution reverted:?\s*(.*)/i);
  const reason = m?.[1]?.trim();
  return reason
    ? { raw: reason, text: `The contract stopped it with the message "${reason}".`, kind: kindOf(reason) }
    : { raw: null, text: "The contract stopped it without giving a reason.", kind: "unknown" };
}

/** Name an unknown custom error via the public openchain signature database (best effort, 8 s). */
async function lookupError(selector) {
  try {
    const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`, {
      signal: AbortSignal.timeout(8000),
    });
    const hits = (await r.json()).result?.function?.[selector] ?? [];
    return hits.length === 1 ? hits[0].name : null; // ambiguous matches are not trusted
  } catch {
    return null;
  }
}

export function kindOf(reason) {
  return STRING_KINDS.find(([re]) => re.test(reason))?.[1] ?? "unknown";
}

export function render(d) {
  if (!d.found) {
    return [
      `Transaction ${d.hash}`,
      ``,
      `I can't find this transaction on Pharos mainnet.`,
      `If your wallet showed an error before sending (for example "insufficient funds for gas"), it was never broadcast, so nothing happened and no fee was paid.`,
      `If you just sent it, wait a few seconds and ask again. Otherwise check the hash and the network.`,
    ].join("\n");
  }
  if (d.ok) return `Transaction ${d.hash}\n\nThis transaction did not fail: it succeeded in block ${d.block}.\n${d.link}`;
  return [
    `Transaction ${d.hash}`,
    `${d.link}`,
    ``,
    `What happened: the transaction from ${label(d.from)} to ${d.to ? label(d.to) : "a new contract"} failed in block ${d.block.toLocaleString("en-US")}. Nothing it tried to do took effect, but the network fee of ${human(d.fee, 18, 6)} ${NATIVE} was still paid.`,
    ``,
    `Why: ${d.why}`,
    ``,
    `What you can do: ${ADVICE[d.kind] ?? ADVICE.unknown}`,
    ``,
    `(failure type: ${d.kind}${d.revert?.raw ? `; raw reason: ${d.revert.raw}` : ""}; gas ${d.gasUsed}/${d.gasLimit})`,
  ].join("\n");
}
