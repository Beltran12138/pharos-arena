#!/usr/bin/env node
// Doc-Grounded Builder (Pharos Agent Arena, Hard): "how do I do X on Pharos?" end to end.
//
//   node doc-grounded-builder/builder.mjs [--from 0x…] "How do I …?"      plan from the docs, execute, verify
//   node doc-grounded-builder/builder.mjs verify doc-grounded-builder/out/<id>.json    after a prepared tx was signed
//
//   1. PLAN    Docs MCP askQuestion → the answer and its sources; the steps are the commands the answer gives
//              (plan.mjs). Every address and function in them is checked against docs pages fetched with getPage.
//   2. EXECUTE Chain MCP: reads run; anything that moves funds is prepared as an unsigned transaction (out/), and
//              signed by the user (sign.mjs). Steps the docs pages do not back are not run.
//   3. VERIFY  each step against the plan, through a second channel (the docs' own RPC endpoint, called directly).
// No command in the answer, or the answer says the docs don't cover it → it says so and does nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress } from "viem";
import { connect, connectDocs, parseDocsAnswer } from "../lib/mcp.mjs";
import { CHAIN_ID, RPC_URL, human, txLink } from "../lib/pharos.mjs";
import { jsonSafe, prepare, validate } from "../lib/payment.mjs";
import { RPC_TO_MCP, decimalsClaim, fill, ground, requestInputs, stepsFrom } from "./plan.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const from = opt("--from", "0x6Ea606Ec600F47411Bf56DF699cF695A0b0E9071");
const replay = opt("--answer"); // replay a saved Docs MCP answer instead of asking (to re-check an earlier answer)
const positional = args.filter((a, i) => !a.startsWith("--") && !["--from", "--answer"].includes(args[i - 1]));
const indent = (s, p = "    ") => s.replace(/^/gm, p);
const MAINNET_RPC = /^https:\/\/rpc\.pharos\.xyz\/?$/;

/** JSON-RPC straight to the endpoint the docs name: the second channel for verification. */
async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i >= 3 || /execution reverted/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

/** Docs MCP calls time out now and then (-32001 after 60 s); try again twice. */
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 2 || !/timed out|-32001|429|fetch failed|ECONNRESET/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

if (positional[0] === "verify") await verify(positional[1]);
else await run(positional.join(" "));

async function run(question) {
  const [docs, mcp] = await Promise.all([connectDocs(), connect()]);
  try {
    console.log(`» ${question}\n`);
    // ── 1. PLAN ──
    const a = parseDocsAnswer(replay ? readFileSync(replay, "utf8") : await retry(() => docs.ask(question, "I am an agent that will carry this out on Pharos Pacific Mainnet. Give the exact contract addresses and a runnable cast command or JSON-RPC request, and say plainly what the docs don't document.")));
    console.log(`1. PLAN (Docs MCP)\n  The docs answer${replay ? ` (replayed from ${replay}, not asked now)` : ""}:`);
    console.log(indent(a.body));
    // getPage returns markdown with escapes (eth\_getCode); unescape so facts can be matched literally.
    const fetchPage = async (p) => ({ ...p, text: (await retry(() => docs.page(p.url)).catch(() => "")).replace(/\\([_*`#\[\]()|-])/g, "$1") });
    const pagesToRead = [...a.cited, ...a.sources.filter((s) => !a.cited.some((c) => c.url === s.url))].filter((p) => p.url.startsWith("https://docs.pharos.xyz")).slice(0, 6);
    const pages = (await Promise.all(pagesToRead.map(fetchPage))).filter((p) => p.text);
    console.log(`\n  Sources (fetched with getPage, used to check every fact below): ${pages.map((p) => `${p.title} <${p.url}>`).join("; ")}`);

    const inputs = requestInputs(question);
    const raw = stepsFrom(a.body);
    const prose = a.body.replace(/```[\s\S]*?```/g, " ");
    const gaps = prose.split(/(?<=[.!?])\s+|\n+/).filter((s) => /\b(docs?|documentation|documented?)\b/i.test(s) && /\b(don[’']t|doesn[’']t|do not|does not|can[’']t|cannot|not|no)\b/i.test(s)).map((s) => s.trim()).filter(Boolean);
    // A request to do something (not just look something up) is covered only if the docs give a grounded command that does it.
    const wants = /\b(wrap|stake|delegate|bridge|send|transfer|pay|deposit|supply|swap|approve|mint|deploy)\b/i.exec(question)?.[1]?.toLowerCase();
    const notCovered = (why, more = "") => {
      console.log(`\n  → NOT COVERED: ${why}, so I am not doing it.`);
      for (const g of gaps) console.log(`    the docs answer says: "${g}"`);
      if (more) console.log(`    ${more}`);
    };
    if (!raw.length) {
      notCovered(`the docs give no command or request that does ${wants ? `the ${wants}` : "this"}`);
      console.log(`\n→ NOT COVERED: nothing was executed or prepared.`);
      process.exitCode = 3;
      return;
    }

    console.log(`\n  Steps taken from the commands in the answer, and where each fact comes from:`);
    const plan = [];
    for (const [i, s0] of raw.entries()) {
      const { step, missing } = fill(s0, inputs);
      let facts = ground(step, pages, inputs, gaps);
      // Before calling a fact unsupported, look it up: searchDocumentation, then read the pages it points to.
      for (const f of facts.filter((f) => f.source === "answer only")) {
        const hits = [...(await retry(() => docs.search(String(f.value))).catch(() => "")).matchAll(/^Title: (.*)\nLink: (.*)$/gm)].map((m) => ({ title: m[1], url: m[2].trim() }));
        for (const h of hits.filter((h) => !pages.some((p) => p.url === h.url)).slice(0, 2)) pages.push(await fetchPage(h));
      }
      facts = ground(step, pages, inputs, gaps);
      const problems = [];
      if (missing.length) problems.push(`the request does not give ${missing.join(", ")}`);
      const loose = facts.filter((f) => f.source === "answer only" || f.source === "disclaimed");
      if (loose.length) problems.push(`not backed by the docs pages: ${loose.map((f) => `${f.fact} ${f.value}`).join(", ")}`);
      if (step.rpc && !MAINNET_RPC.test(step.rpc)) problems.push(`the command targets ${step.rpc}, not Pacific Mainnet (Chain MCP serves mainnet only)`);
      plan.push({ step, facts, problems });
      console.log(`  ${i + 1}. ${step.command}`);
      for (const f of facts) console.log(`       ${f.fact} ${f.value}: ${f.source}${f.where ? ` (${f.where})` : ""}`);
      for (const p of problems) console.log(`       ✗ ${p} → this step will not run`);
    }
    const doesIt = !wants || plan.some((p) => p.step.kind === "send" && !p.problems.length);
    if (!doesIt) notCovered(`no command in the docs answer that does the ${wants} is backed by the docs pages`, plan.some((p) => p.step.kind !== "send") ? "The read-only checks the answer suggests run below, for information only." : "");
    else if (gaps.length) console.log(`  What the docs answer says is not documented:\n${gaps.map((g) => `    - ${g}`).join("\n")}`);

    // ── 2. EXECUTE + 3. VERIFY ──
    const block = Number((await mcp.call("get_block_number")).blockNumber);
    console.log(`\n2. EXECUTE (Chain MCP, block ${block.toLocaleString("en-US")}) and 3. VERIFY (direct JSON-RPC to ${RPC_URL}, the endpoint the docs name)`);
    const results = [];
    for (const [i, p] of plan.entries()) {
      const n = `  ${i + 1}.`;
      if (p.problems.length) { console.log(`${n} not run: ${p.problems.join("; ")}`); results.push("skipped"); continue; }
      const s = p.step;
      if (s.kind === "call") results.push(await execCall(mcp, s, block, n, a.body, pages));
      else if (s.kind === "rpc") results.push(await execRpc(mcp, s, n, pages));
      else if (s.kind === "code") results.push(await execRpc(mcp, { ...s, method: "eth_getCode", params: [s.to, "latest"] }, n, pages));
      else results.push(await execSend(mcp, s, inputs, n, question, a, p));
    }
    if (!doesIt) {
      console.log(`\n→ NOT COVERED: the ${wants} is not documented; nothing was prepared.${results.some((r) => r === "ok") ? " The read-only checks that ran were verified." : ""}`);
      process.exitCode = 3;
      return;
    }
    const ok = results.filter((r) => r === "ok" || r === "prepared").length;
    console.log(`\n→ ${results.every((r) => r === "ok") ? "DONE" : results.includes("prepared") && !results.includes("failed") ? "PREPARED" : "INCOMPLETE"}: ${ok} of ${results.length} steps as planned${results.includes("prepared") ? "; the transaction waits for the owner's signature, then: builder.mjs verify <file>" : ""}`);
    if (results.includes("failed") || results.includes("skipped")) process.exitCode = 1;
  } finally {
    await Promise.all([docs.close(), mcp.close()]);
  }
}

/** cast call → eth_call through Chain MCP; the same call through the docs' RPC must agree. Units: as the docs state them, checked on chain. */
async function execCall(mcp, s, block, n, body, pages) {
  const data = encodeFunctionData({ abi: [s.fn], functionName: s.fn.name, args: s.args });
  const via = await mcp.call("eth_call", { transaction: { to: s.to, data }, block: String(block) }).then((r) => (typeof r === "string" ? r : r.result ?? r.data));
  const value = decodeFunctionResult({ abi: [s.fn], functionName: s.fn.name, data: via });
  console.log(`${n} ${s.fn.name}(${s.args.join(", ")}) on ${s.to} → ${value}`);
  // Second channel. A mismatch is re-read (historical reads on this RPC are occasionally wrong), then reported.
  let direct;
  for (let i = 0; i < 3 && direct !== via; i++) direct = await rpc("eth_call", [{ to: s.to, data }, `0x${block.toString(16)}`]);
  console.log(`     verify: same call via ${RPC_URL} at the same block → ${direct === via ? "identical" : `DIFFERENT (${direct})`}`);
  if (direct !== via) return "failed";
  if (typeof value !== "bigint") return "ok";
  if (/time/i.test(s.fn.name)) {
    const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
    console.log(`     → a unix time: ${new Date(Number(value) * 1000).toISOString()}, ${now - Number(value)} s before this block`);
    return "ok";
  }
  // Scaling an amount: the decimals the answer claims, whether a fetched page that lists this contract states them,
  // and decimals() on chain, which wins if they disagree. (Not for decimals() itself, ids, counts.)
  if (!/balance|answer|price|supply|amount|allowance/i.test(s.fn.name)) return "ok";
  const claim = decimalsClaim(body);
  const word = Object.entries({ 6: "six", 8: "eight", 18: "eighteen" }).find(([d]) => Number(d) === claim)?.[1];
  const onPage = claim == null ? null : pages.find((p) => new RegExp(`\\b(${claim}${word ? `|${word}` : ""})[\\s-]+decimal|decimals[^\\n]{0,40}\\b${claim}\\b`, "i").test(p.text) && p.text.toLowerCase().includes(s.to.toLowerCase()));
  const chainDec = await mcp.call("eth_call", { transaction: { to: s.to, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) }, block: String(block) }).then((r) => Number(BigInt(typeof r === "string" ? r : r.result)), () => null);
  const dec = chainDec ?? claim;
  console.log(`     units: ${claim == null ? "the answer gives no decimals" : `the answer says ${claim} decimals; ${onPage ? `stated on ${onPage.title}` : "no fetched page that lists this contract states that"}`}; decimals() on chain: ${chainDec ?? "not callable"}${chainDec != null && claim != null && chainDec !== claim ? " — DISAGREES with the answer, using the chain" : ""}`);
  if (dec != null) console.log(`     → ${formatUnits(value, dec)}`);
  return "ok";
}

/** JSON-RPC request from the docs → the matching Chain MCP tool; the docs' request sent as-is to their RPC must agree. */
async function execRpc(mcp, s, n, pages) {
  const map = RPC_TO_MCP[s.method];
  if (!map) { console.log(`${n} ${s.method}: no Chain MCP tool for it; skipped`); return "skipped"; }
  const [tool, targs] = map(s.params);
  const viaMcp = await mcp.call(tool, targs).catch((e) => ({ error: e.message }));
  const direct = await rpc(s.method, s.params).catch((e) => ({ error: e.message }));
  console.log(`${n} ${s.method}(${s.params.join(", ")}) via Chain MCP ${tool}`);
  if (s.method === "eth_getTransactionReceipt") {
    if (viaMcp == null || viaMcp.error || direct == null) {
      console.log(`     no receipt: ${viaMcp?.error ?? "null"} — per the docs, null means no receipt is available for that hash (yet)`);
      return "failed";
    }
    const status = viaMcp.status;
    // What a status means: from a docs page if one defines it; otherwise the Ethereum standard, said as such.
    const defined = pages.find((p) => /status[^\n]{0,60}\b0x1\b[^\n]{0,60}\b(success|succeeded)/i.test(p.text) || /\b0x1\b[^\n]{0,30}means[^\n]{0,30}succe/i.test(p.text));
    const meaning = defined ? `"0x1" = success per ${defined.title}` : `the fetched docs pages show "status": "0x1" only in an example and don't define it; 0x1 = success / 0x0 = failure is the Ethereum receipt standard (EIP-658), not a Pharos docs statement`;
    console.log(`     status ${status} → ${status === "0x1" ? "succeeded" : "FAILED"} (${meaning}); block ${Number(BigInt(viaMcp.blockNumber)).toLocaleString("en-US")}, gas used ${Number(BigInt(viaMcp.gasUsed)).toLocaleString("en-US")}, ${viaMcp.logs?.length ?? 0} logs, from ${viaMcp.from} to ${viaMcp.to}`);
    const same = ["status", "blockNumber", "blockHash", "gasUsed"].every((k) => String(direct[k]).toLowerCase() === String(viaMcp[k]).toLowerCase()) && direct.logs.length === (viaMcp.logs?.length ?? 0);
    console.log(`     verify: the docs' request sent to ${RPC_URL} → ${same ? "same status, block, block hash, gas and log count" : `DIFFERENT: ${JSON.stringify({ status: direct.status, blockNumber: direct.blockNumber, gasUsed: direct.gasUsed })}`}`);
    console.log(`     ${txLink(s.params[0])}`);
    return same ? "ok" : "failed";
  }
  const got = viaMcp?.result ?? viaMcp?.code ?? viaMcp;
  const same = JSON.stringify(direct) === JSON.stringify(got);
  const show = (x) => (s.method === "eth_getCode" && typeof x === "string" ? (x === "0x" ? "0x (no code: not a contract)" : `${(x.length - 2) / 2} bytes of contract code, ${x.slice(0, 18)}…`) : JSON.stringify(x).slice(0, 200));
  console.log(`     → ${show(got)}\n     verify: the same request sent to ${RPC_URL} ${same ? "→ identical" : `→ DIFFERENT: ${show(direct)}`}`);
  return same ? "ok" : "failed";
}

/** cast send → validated and prepared as an unsigned transaction for the owner; never signed here. */
async function execSend(mcp, s, inputs, n, question, a, p) {
  if (s.fn) { console.log(`${n} contract call with value: only plain transfers are prepared here; skipped`); return "skipped"; }
  const amount = formatUnits(s.value, 18);
  if (inputs.amount && (inputs.amount.symbol !== "PROS" || inputs.amount.value !== amount.replace(/\.0$/, ""))) {
    console.log(`${n} the command sends ${amount} PROS but the request asked for ${inputs.amount.value} ${inputs.amount.symbol}; not preparing it`);
    return "failed";
  }
  const v = await validate(mcp, { from, to: s.to, symbol: "PROS", amount });
  console.log(`${n} send ${amount} PROS from ${from} to ${s.to}: checks before preparing`);
  for (const c of v.checks) console.log(`     ${c.ok ? (c.level === "warn" ? "!" : "✓") : "✗"} ${c.name}: ${c.detail}`);
  if (v.checks.some((c) => !c.ok && c.level === "error")) { console.log(`     not prepared`); return "failed"; }
  const prep = await prepare(mcp, v, from);
  const id = `send-${amount}-PROS-${s.to.slice(2, 8).toLowerCase()}-n${prep.unsigned.nonce}`;
  mkdirSync(join(here, "out"), { recursive: true });
  const file = join(here, "out", `${id}.json`);
  writeFileSync(file, JSON.stringify(jsonSafe({ id, question, docsAnswer: a.body, sources: a.sources.slice(0, 6), plan: { command: s.command, facts: p.facts, expect: { from: getAddress(from), to: v.recipient, value: s.value, status: "0x1" } }, ...prep }), null, 1));
  console.log(`     prepared, unsigned (nonce ${prep.unsigned.nonce}, gas ${prep.unsigned.gas}, ≈ ${human(prep.unsigned.gas * prep.unsigned.gasPrice, 18)} PROS fee): doc-grounded-builder/out/${id}.json`);
  console.log(`     wallet request: ${prep.uri}`);
  console.log(`     the owner signs it: node --env-file=.env doc-grounded-builder/sign.mjs doc-grounded-builder/out/${id}.json`);
  return "prepared";
}

/** After signing: the transaction against the plan — receipt status (the docs' criterion), sender, recipient, value, nonce, balance change. */
async function verify(file) {
  const f = JSON.parse(readFileSync(file, "utf8"));
  const sent = JSON.parse(readFileSync(file.replace(/\.json$/, ".sent.json"), "utf8"));
  const mcp = await connect();
  try {
    console.log(`» verify: ${f.question}\n  plan: ${f.plan.command}\n  tx ${txLink(sent.hash)}\n`);
    const [tx, rc] = [await mcp.call("get_transaction", { hash: sent.hash }), await mcp.call("get_transaction_receipt", { hash: sent.hash })];
    const directRc = await rpc("eth_getTransactionReceipt", [sent.hash]);
    const blk = Number(BigInt(rc.blockNumber));
    const bal = async (addr, b) => BigInt((await rpc("eth_getBalance", [addr, `0x${b.toString(16)}`])));
    const [toBefore, toAfter] = [await bal(f.plan.expect.to, blk - 1), await bal(f.plan.expect.to, blk)];
    const checks = [
      ["receipt status (0x1 = success: the Ethereum receipt standard, EIP-658; the Pharos docs show it only in an example)", rc.status === "0x1" && directRc.status === "0x1", `${rc.status} via Chain MCP, ${directRc.status} via ${RPC_URL}`],
      ["chain", Number(BigInt(tx.chainId ?? CHAIN_ID)) === CHAIN_ID, `chain ${Number(BigInt(tx.chainId ?? CHAIN_ID))}`],
      ["from", getAddress(tx.from) === getAddress(f.plan.expect.from), tx.from],
      ["to", getAddress(tx.to) === getAddress(f.plan.expect.to), tx.to],
      ["value", BigInt(tx.value) === BigInt(f.plan.expect.value), `${formatUnits(BigInt(tx.value), 18)} PROS`],
      ["nonce = the prepared one", Number(BigInt(tx.nonce)) === Number(f.unsigned.nonce), `${Number(BigInt(tx.nonce))}`],
      ["recipient balance change", toAfter - toBefore === BigInt(f.plan.expect.value), `${formatUnits(toBefore, 18)} → ${formatUnits(toAfter, 18)} PROS between blocks ${blk - 1} and ${blk}`],
    ];
    for (const [name, ok, detail] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}: ${detail}`);
    const ok = checks.every((c) => c[1]);
    console.log(`\n→ ${ok ? "SUCCESS" : "FAILED"} against the plan (block ${blk.toLocaleString("en-US")}, gas used ${Number(BigInt(rc.gasUsed)).toLocaleString("en-US")})`);
    if (!ok) process.exitCode = 1;
  } finally {
    await mcp.close();
  }
}
