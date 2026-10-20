// Validate a payment and prepare it as an unsigned transaction. Shared by the payment agents. Nothing here
// signs or sends: the output is an unsigned transaction and a wallet signing request (EIP-681 URI).
import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, serializeTransaction, toHex } from "viem";
import { CHAIN_ID, NATIVE, TOKENS, human, read } from "./pharos.mjs";

export const BY_SYMBOL = {
  [NATIVE]: { symbol: NATIVE, decimals: 18, native: true },
  ...Object.fromEntries(Object.entries(TOKENS).map(([address, t]) => [t.symbol, { address, ...t }])),
};

/** Parse a decimal amount for a token; refuses more decimals than the token has instead of rounding. */
export function toRaw(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${amount}" is not a plain number`);
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) throw new Error(`${s} has ${frac.length} decimals; this token has ${decimals}`);
  return parseUnits(s, decimals);
}

/**
 * Checks before anything is prepared. Each check: { name, ok, level: "error"|"warn", detail }.
 * errors block; warnings are shown to the user in the summary.
 */
export async function validate(mcp, { from, to, symbol, amount, memo }) {
  const checks = [];
  const add = (name, ok, detail, level = "error") => checks.push({ name, ok, level, detail });
  const token = BY_SYMBOL[symbol];
  add("token known", !!token, token ? `${symbol}${token.native ? " (native)" : ` at ${token.address}`}` : `"${symbol}" is not a Pharos mainnet token this agent knows (${Object.keys(BY_SYMBOL).join(", ")})`);

  // Recipient: well-formed, checksum respected when mixed case, not a burn/zero address, not the token itself.
  const wellFormed = typeof to === "string" && isAddress(to, { strict: false });
  // All-lower or all-upper hex carries no checksum; mixed case must match EIP-55 exactly.
  const hex = wellFormed ? to.slice(2) : "";
  const checksumOk = wellFormed && (hex === hex.toLowerCase() || hex === hex.toUpperCase() || getAddress(to) === to);
  add("recipient format", wellFormed && checksumOk, !wellFormed ? `"${to}" is not a 0x address (40 hex characters)` : checksumOk ? getAddress(to) : `${to} has a wrong checksum (mixed case does not match): likely a typo`);
  let raw = null;
  if (token) {
    try {
      raw = toRaw(amount, token.decimals);
      add("amount", raw > 0n, `${human(raw, token.decimals)} ${symbol}`);
    } catch (e) {
      add("amount", false, e.message);
    }
  }
  if (!checks.every((c) => c.ok)) return { checks, token, raw };

  const recipient = getAddress(to);
  add("recipient not zero/burn", !/^0x0{40}$|^0x0{36}dead$/i.test(recipient), recipient);
  if (token && !token.native) add("recipient is not the token contract", recipient.toLowerCase() !== token.address, "sending tokens to the token contract itself loses them");
  const code = await mcp.call("get_code", { address: recipient });
  const isContract = (code.code ?? code) !== "0x";
  add("recipient type", true, isContract ? "a contract: make sure it can receive this token" : "a regular account (no contract code)", isContract ? "warn" : "info");

  // Token contract: code exists and symbol/decimals on chain match what we expect.
  if (!token.native) {
    const [sym, dec] = [await read(mcp, token.address, erc20Abi, "symbol"), Number(await read(mcp, token.address, erc20Abi, "decimals"))];
    add("token contract", sym === symbol && dec === token.decimals, `on chain: symbol ${sym}, decimals ${dec}`);
  }

  // Balances and a simulation from the sender.
  const tx = buildCall({ token, to: recipient, raw, memo });
  const [{ balanceWei }, { gasPriceWei }] = [await mcp.call("get_balance", { address: from }), await mcp.call("get_gas_price")];
  const have = token.native ? BigInt(balanceWei) : await read(mcp, token.address, erc20Abi, "balanceOf", [from]);
  add("balance", have >= raw, `sender holds ${human(have, token.decimals)} ${symbol}, needs ${human(raw, token.decimals)}`);
  let gas = null;
  try {
    const est = await mcp.call("estimate_gas", { transaction: { from, to: tx.to, value: toHex(tx.value), data: tx.data } });
    gas = BigInt(est.gas ?? est.gasEstimate ?? est.result ?? est);
    add("simulation", true, `estimate_gas from the sender succeeds: ${gas} gas`);
  } catch (e) {
    const why = /"message":\s*"([^"]+)"/.exec(e.message)?.[1] ?? String(e.message).slice(0, 160);
    add("simulation", false, `estimate_gas from the sender fails: ${why}`);
  }
  if (gas) {
    const fee = ((gas * 12n) / 10n) * BigInt(gasPriceWei);
    const left = BigInt(balanceWei) - (token.native ? raw : 0n);
    add("gas", left >= fee, `fee ≈ ${human(fee, 18)} ${NATIVE}; sender has ${human(left, 18)} ${NATIVE} for it`);
  }
  return { checks, token, raw, recipient, tx, gas, gasPriceWei: BigInt(gasPriceWei), have, nativeBalance: BigInt(balanceWei) };
}

/** to/value/data for a payment. A memo (invoice reference) rides in the calldata: appended after the ERC-20
 * arguments (ignored by the token, visible on chain), or as the data of a native transfer. */
export function buildCall({ token, to, raw, memo }) {
  const tail = memo ? toHex(new TextEncoder().encode(memo)).slice(2) : "";
  if (token.native) return { to, value: raw, data: memo ? `0x${tail}` : "0x" };
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, raw] }) + tail;
  return { to: getAddress(token.address), value: 0n, data };
}

/** The unsigned transaction (legacy, chain 1672) plus an EIP-681 signing request. */
export const nonceOf = async (mcp, address, block = "pending") => {
  const n = await mcp.call("get_transaction_count", { address, block });
  return Number(n.nonce ?? n.transactionCount ?? n.count ?? n);
};

/** `nonce` can be given when several prepared transactions are outstanding, so they do not collide. */
export async function prepare(mcp, v, from, nonce) {
  nonce ??= await nonceOf(mcp, from);
  const unsigned = { chainId: CHAIN_ID, type: "legacy", from: getAddress(from), to: v.tx.to, value: v.tx.value, data: v.tx.data, nonce, gas: (v.gas * 12n) / 10n, gasPrice: v.gasPriceWei };
  const { from: _, ...forSerialize } = unsigned;
  const serialized = serializeTransaction(forSerialize);
  const uri = v.token.native
    ? `ethereum:${v.recipient}@${CHAIN_ID}?value=${v.raw}`
    : `ethereum:${getAddress(v.token.address)}@${CHAIN_ID}/transfer?address=${v.recipient}&uint256=${v.raw}`;
  return { unsigned, serialized, uri };
}

export const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, x) => (typeof x === "bigint" ? x.toString() : x)));
