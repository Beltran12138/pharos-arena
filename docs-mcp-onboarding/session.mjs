#!/usr/bin/env node
// Docs MCP Onboarding (Pharos Agent Arena, Easy): the onboarding session, replayable. Asks Developer Docs MCP
// the questions a newcomer to ai.pharos.xyz would ask, in order, and records every query and answer verbatim
// to session-log.md. The analysis (gaps, fixes) is written by hand in README.md from this log.
//
//   node docs-mcp-onboarding/session.mjs
import { writeFileSync } from "node:fs";
import { connectDocs, DOCS_MCP_URL } from "../lib/mcp.mjs";

const GOAL = "I am a developer onboarding onto ai.pharos.xyz to build agents on Pharos using only the docs.";
const STEPS = [
  ["Find out what ai.pharos.xyz is", "ask", "What is ai.pharos.xyz and what can a developer do there?"],
  ["Connect the chain tools", "ask", "How do I connect the Pharos Chain MCP server to my agent? What is its endpoint URL?"],
  ["Connect the docs tools", "ask", "Is there an MCP server for the Pharos developer docs, and what URL do I add to my MCP client?"],
  ["Learn the Chain MCP surface", "ask", "Which tools does the Pharos Chain MCP expose, and what rate limits apply to the hosted endpoint?"],
  ["Know what the hosted MCP can't do", "ask", "Can the hosted Pharos Chain MCP send transactions, or is it read-only?"],
  ["Install the skill engine", "ask", "How do I install and use the Pharos Skill Engine with an AI agent?"],
  ["Get gas", "ask", "How do I get PROS for gas on Pharos mainnet?"],
  ["Read a price on chain", "ask", "How do I read the PROS/USD price and its timestamp on chain on Pharos mainnet?"],
  ["Find a testnet token", "ask", "What is the USDC token address on the Atlantic testnet?"],
  ["Find the builder program", "ask", "What is Pharos Season of AI or the Pharos Agent Arena, and how do I submit a build?"],
  ["Search instead of ask", "search", "deploy a contract"],
  ["Search instead of ask", "search", "How do I deploy a contract on Pharos?"],
];

const docs = await connectDocs();
const log = [`# Docs MCP onboarding session (raw log)`, ``, `Endpoint: ${DOCS_MCP_URL}  `, `Run: ${new Date().toISOString()}  `, `Goal passed to askQuestion: "${GOAL}"`, ``];
try {
  for (const [i, [intent, tool, q]] of STEPS.entries()) {
    const t0 = Date.now();
    const answer = tool === "ask" ? await docs.ask(q, GOAL) : await docs.search(q);
    const ms = Date.now() - t0;
    log.push(`## ${i + 1}. ${intent}`, ``, `**${tool === "ask" ? "askQuestion" : "searchDocumentation"}**: \`${q}\` (${(ms / 1000).toFixed(1)} s)`, ``);
    log.push(tool === "search" ? searchSummary(answer) : quote(answer), ``);
    console.error(`${i + 1}/${STEPS.length} ${intent} (${(ms / 1000).toFixed(1)} s)`);
  }
} finally {
  await docs.close();
}
writeFileSync(new URL("./session-log.md", import.meta.url), log.join("\n"));
console.log("wrote docs-mcp-onboarding/session-log.md");

function quote(s) {
  return s.trim().replace(/^/gm, "> ");
}
function searchSummary(s) {
  const hits = [...s.matchAll(/^Title: (.*)\nLink: (.*)$/gm)];
  return hits.length ? `${hits.length} result(s):\n\n` + hits.map((h) => `- ${h[1]} — ${h[2]}`).join("\n") : "0 results.";
}
