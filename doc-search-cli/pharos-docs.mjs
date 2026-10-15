#!/usr/bin/env node
// Doc-Search CLI (Pharos Agent Arena, Easy): ask the Pharos docs a question from the terminal, through the
// Developer Docs MCP server, and get a short sourced answer — or a clear "the docs don't cover this".
//
//   pharos-docs "how do I deploy a contract?"          concise answer + sources
//   pharos-docs --full "..."                           the whole answer
//   pharos-docs --search "chainlink"                   just the matching pages
//
// Exit code: 0 answered, 3 not covered by the docs, 1 error.
import { connectDocs, DOCS_MCP_URL, parseDocsAnswer } from "../lib/mcp.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const searchOnly = args.includes("--search");
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
if (!question) {
  console.error('usage: pharos-docs [--full|--search] "your question"');
  process.exit(2);
}

const MAX_LINES = 14;
const docs = await connectDocs();
try {
  if (searchOnly) {
    const hits = [...(await docs.search(question)).matchAll(/^Title: (.*)\nLink: (.*)$/gm)];
    if (!hits.length) {
      console.log("No matching pages in the Pharos docs.");
      process.exitCode = 3;
    } else hits.forEach((h, i) => console.log(`${i + 1}. ${h[1]}\n   ${h[2]}`));
  } else {
    const a = parseDocsAnswer(await docs.ask(question));
    if (a.notCovered) {
      console.log("✗ The Pharos docs don't answer this.\n");
      console.log(indent(a.body.split("\n").slice(0, 6).join("\n")));
      if (a.sources.length) {
        console.log("\nClosest pages (they do not answer it):");
        for (const s of a.sources.slice(0, 3)) console.log(`  - ${s.title}: ${s.url}`);
      }
      process.exitCode = 3;
    } else {
      const lines = a.body.split("\n");
      if (full || lines.length <= MAX_LINES) console.log(a.body);
      else {
        let cut = lines.slice(0, MAX_LINES).join("\n");
        if ((cut.match(/```/g) ?? []).length % 2) cut += "\n   ```"; // don't leave a code block open
        console.log(cut + "\n  … (--full for the rest)");
      }
      // Pages the answer links to come first: those are what it actually used.
      const ranked = [...a.cited, ...a.sources.filter((s) => !a.cited.some((c) => c.url === s.url))];
      console.log("\nSources:");
      for (const s of ranked.slice(0, full ? 10 : 4)) console.log(`  - ${s.title}: ${s.url}`);
    }
  }
  console.log(`\n(via Developer Docs MCP ${DOCS_MCP_URL})`);
} finally {
  await docs.close();
}

function indent(s) {
  return s.replace(/^/gm, "  ");
}
