import { connect } from "./lib/mcp.mjs";
const m = await connect();
for (const h of process.argv.slice(2)) {
  const tx = await m.call("get_transaction", { hash: h });
  const rc = await m.call("get_transaction_receipt", { hash: h });
  console.log(h.slice(0,10), "status", rc.status, "gas", Number(BigInt(rc.gasUsed)), "/", Number(BigInt(tx.gas)));
  try {
    const r = await m.call("eth_call", { transaction: { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas }, block: String(Number(BigInt(rc.blockNumber)) - 1) });
    console.log("  replay ok:", JSON.stringify(r).slice(0,200));
  } catch (e) { console.log("  replay err:", e.message.slice(0,600)); }
}
await m.close();
