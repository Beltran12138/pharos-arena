// Sign locally, broadcast through Chain MCP send_raw_transaction, confirm through Chain MCP.
// The hosted endpoint forwards signed transactions to the node (a malformed one is rejected by the node with
// TX_OVER_SIZE, not by the MCP), so broadcasting goes through MCP; the public RPC is only a fallback if the
// MCP refuses the tool itself. The key never leaves this process.
import { createPublicClient, http, defineChain } from "viem";
import { CHAIN_ID, NATIVE, RPC_URL, txLink } from "./pharos.mjs";

export const pharos = defineChain({
  id: CHAIN_ID,
  name: "Pharos",
  nativeCurrency: { name: NATIVE, symbol: NATIVE, decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** @returns { hash, via, status, block, gasUsed, link } */
export async function signAndSend(mcp, account, { to, value = 0n, data = "0x", gas }) {
  const [{ gasPriceWei }, nonceRes] = await Promise.all([
    mcp.call("get_gas_price"),
    mcp.call("get_transaction_count", { address: account.address, block: "pending" }),
  ]);
  const nonce = Number(nonceRes.nonce ?? nonceRes.transactionCount ?? nonceRes.count ?? nonceRes);
  const raw = await account.signTransaction({
    chainId: CHAIN_ID,
    type: "legacy",
    to,
    value: BigInt(value),
    data,
    gas: BigInt(gas),
    gasPrice: BigInt(gasPriceWei),
    nonce,
  });

  let hash;
  let via = "Chain MCP send_raw_transaction";
  try {
    const r = await mcp.call("send_raw_transaction", { rawTransaction: raw });
    hash = r.transactionHash ?? r.hash ?? r.result ?? r;
  } catch (e) {
    if (!/disabled|not enabled|unknown tool|not found/i.test(e.message)) throw e;
    via = "public RPC (MCP broadcast unavailable)";
    hash = await createPublicClient({ chain: pharos, transport: http(RPC_URL) }).sendRawTransaction({ serializedTransaction: raw });
  }

  for (let i = 0; i < 30; i++) {
    try {
      const r = await mcp.call("get_transaction_receipt", { hash });
      if (r?.status) {
        return { hash, via, status: r.status === "0x1" ? "success" : "reverted", block: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed), link: txLink(hash) };
      }
    } catch {
      // not mined yet
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { hash, via, status: "sent-unconfirmed", link: txLink(hash) };
}
