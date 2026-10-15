#!/usr/bin/env node
// Docs MCP + Chain MCP Agent (Pharos Agent Arena, Medium): explain a contract function from the Pharos docs,
// call it on chain, and interpret the result in the light of that explanation.
//
//   node docs-chain-mcp-agent/agent.mjs --contract 0x… --name "what the contract is" \
//        --fn "latestAnswer() returns (int256)" [--args '["0x…"]']
//
//   1. Docs MCP askQuestion: what the function does, its parameters and return value (with sources).
//   2. Chain MCP eth_call at a pinned block; decode with the signature.
//   3. Interpret: deterministic facts first (decimals the docs state, timestamps → age, ids/addresses the
//      docs list → match or mismatch), then Docs MCP again, asked about this concrete result.
// If the docs don't cover the function, it says so and stops at the raw value instead of guessing.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { connect, connectDocs, parseDocsAnswer } from "../lib/mcp.mjs";
import { addrLink } from "../lib/pharos.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const contract = opt("--contract");
const name = opt("--name", "contract");
const fnSig = opt("--fn");
const fnArgs = JSON.parse(opt("--args", "[]"));
if (!contract || !fnSig) {
  console.error('usage: agent.mjs --contract 0x… --name "…" --fn "fn(types) returns (types)" [--args \'[…]\']');
  process.exit(2);
}
const abi = parseAbi([`function ${fnSig.replace(/\)\s*returns/, ") view returns")}`]);
const fn = abi[0];
const call = `${fn.name}(${fnArgs.map(String).join(", ")})`;

const [docs, chain] = await Promise.all([connectDocs(), connect()]);
try {
  // ── 1. explain (Docs MCP) ──
  console.log(`## 1. What the docs say about ${fn.name} on ${name}\n`);
  const explain = parseDocsAnswer(
    await docs.ask(
      `On Pharos, what does the function ${fn.name}() do on the ${name} (${contract})? What are its parameters and what does its return value mean, including units or decimals?`,
      "I am about to call this function on Pharos mainnet and need to interpret the value it returns.",
    ),
  );
  console.log(indent(explain.body));
  console.log(sources(explain));

  // ── 2. call (Chain MCP) ──
  const { blockNumber } = await chain.call("get_block_number");
  const blk = await chain.call("get_block", { block: blockNumber });
  const now = Number(BigInt(blk.timestamp));
  const data = encodeFunctionData({ abi, functionName: fn.name, args: fnArgs });
  console.log(`\n## 2. Calling it on chain (Chain MCP eth_call)\n`);
  console.log(`  ${name} ${contract}`);
  console.log(`  ${addrLink(contract)}`);
  console.log(`  block ${Number(blockNumber).toLocaleString("en-US")} (${new Date(now * 1000).toISOString()})`);
  let res;
  try {
    res = await chain.call("eth_call", { transaction: { to: contract, data }, block: blockNumber });
  } catch (e) {
    console.log(`  ${call} → REVERTED (${e.message.match(/"message":\s*"([^"]*)"/)?.[1] ?? "no reason"})`);
    console.log(`\n## 3. What the result means\n`);
    console.log(
      explain.notCovered
        ? `  The docs don't describe this function and the contract rejects it: it is not part of this contract's interface.`
        : `  The docs describe ${fn.name}() for this contract, but on chain the call reverts. The docs and the deployed contract disagree; don't build on this function until that is resolved.`,
    );
    process.exitCode = 4;
    await Promise.all([docs.close(), chain.close()]);
    process.exit();
  }
  const decoded = decodeFunctionResult({ abi, functionName: fn.name, data: res.result ?? res });
  const values = Array.isArray(decoded) ? decoded : [decoded];
  console.log(`  ${call} → ${values.map(String).join(", ")}`);

  // ── 3. interpret ──
  console.log(`\n## 3. What the result means\n`);
  if (explain.notCovered) {
    console.log(`  The docs don't explain this function, so I won't interpret ${values.map(String).join(", ")} beyond the raw value.`);
    process.exitCode = 3;
  } else {
    const facts = interpret(values, fn.outputs, explain.body + "\n" + (await docSourceText(docs, explain)), now);
    if (facts.length) {
      console.log(`  Checked against the explanation:`);
      for (const f of facts) console.log(`  - ${f}`);
      console.log();
    }
    const meaning = parseDocsAnswer(
      await docs.ask(
        `On Pharos mainnet at block ${blockNumber} (unix time ${now}), calling ${call} on the ${name} (${contract}) returned ${values.map(String).join(", ")}. Based on the documentation, what does this value mean in plain terms?`,
      ),
    );
    console.log(indent(meaning.body));
    console.log(sources(meaning));

    // The docs answers name other functions to call next; check that those exist on this contract.
    const named = [...new Set([...(explain.body + meaning.body).matchAll(/`(\w+)\(\)`|`(\w+)`(?=\s+(?:on the proxy|function))/g)].map((m) => m[1] ?? m[2]))].filter((n) => n !== fn.name);
    if (named.length) {
      console.log(`\n  Functions the docs point to, tried on this contract (no-argument calls):`);
      for (const n of named) {
        try {
          const r = await chain.call("eth_call", { transaction: { to: contract, data: encodeFunctionData({ abi: parseAbi([`function ${n}()`]), functionName: n }) }, block: blockNumber });
          console.log(`  - ${n}(): responds (${String(r.result ?? r).slice(0, 66)})`);
        } catch {
          console.log(`  - ${n}(): REVERTS on this contract — the docs suggest it, but it is not callable here.`);
        }
      }
    }
  }
} finally {
  await Promise.all([docs.close(), chain.close()]);
}

/** Deterministic readings of the result, using only what the docs text states. */
function interpret(values, outputs, docText, now) {
  const out = [];
  const dec = docText.match(/\b(\d{1,2})\s+decimals\b/i) ?? docText.match(/decimals[^0-9]{0,40}(\d{1,2})\b/i);
  values.forEach((v, i) => {
    const type = outputs[i]?.type ?? "";
    if (typeof v === "bigint" && v > 1_000_000_000n && v < 4_000_000_000n) {
      const age = now - Number(v);
      out.push(`${String(v)} is a unix timestamp: ${new Date(Number(v) * 1000).toISOString()}, ${age} s before this block${age > 3600 ? " (older than the 1-hour heartbeat the docs give)" : ""}.`);
    } else if (typeof v === "bigint" && dec) {
      const d = Number(dec[1]);
      out.push(`The docs say values use ${d} decimals, so ${String(v)} = ${(Number(v) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: 8 })}.`);
    } else if (type === "bytes32" || type === "address") {
      const hit = docText.toLowerCase().includes(String(v).toLowerCase());
      out.push(`${String(v)} ${hit ? "matches the value listed in the docs" : "does NOT appear in the docs text I retrieved"}.`);
    }
  });
  return out;
}

/** The pages the explanation cited, fetched through Docs MCP, so facts can be checked against the source. */
async function docSourceText(docs, a) {
  const pages = a.cited.length ? a.cited : a.sources.slice(0, 1);
  const texts = await Promise.all(pages.slice(0, 2).map((p) => docs.page(p.url).catch(() => "")));
  return texts.join("\n");
}

function sources(a) {
  const list = [...a.cited, ...a.sources.filter((s) => !a.cited.some((c) => c.url === s.url))].slice(0, 3);
  return list.length ? `\n  Sources: ${list.map((s) => `${s.title} <${s.url}>`).join("; ")}` : "";
}

function indent(s) {
  return s.replace(/^/gm, "  ");
}
