// Thin clients for the two Pharos MCP servers:
//   Chain MCP  (hosted, read-only)  https://mcp.pharos.xyz/mcp
//   Docs MCP   (GitBook)            https://docs.pharos.xyz/~gitbook/mcp
// Every chain read and every docs lookup in this repo goes through here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";
export const DOCS_MCP_URL = process.env.PHAROS_DOCS_MCP_URL ?? "https://docs.pharos.xyz/~gitbook/mcp";

/** Chain MCP. `call` returns parsed JSON when the tool answers with JSON. */
export async function connect(url = MCP_URL) {
  const client = new Client({ name: "pharos-arena", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name, args = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
      if (!res.isError) return parse(text);
      // hosted endpoint: 120 req/min per IP
      if (/429|rate/i.test(text) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${name}: ${text}`);
    }
  };
  return { client, call, close: () => client.close() };
}

/** Docs MCP. Tools: searchDocumentation, getPage, askQuestion (sendFeedback is never called here). */
export async function connectDocs(url = DOCS_MCP_URL) {
  const client = new Client({ name: "pharos-arena", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const text = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const t = res.content?.map((c) => c.text ?? "").join("") ?? "";
    if (res.isError) throw new Error(`${name}: ${t}`);
    return t;
  };
  return {
    client,
    ask: (question, goal) => text("askQuestion", goal ? { question, goal } : { question }),
    search: (query) => text("searchDocumentation", { query }),
    page: (url) => text("getPage", { url }),
    close: () => client.close(),
  };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Split an askQuestion answer into body and source links; flag answers where the docs say they don't cover it. */
export function parseDocsAnswer(raw, base = "https://docs.pharos.xyz") {
  const [body, sourcesBlock = ""] = raw.split(/\n#\s*Sources\s*\n/);
  const link = (u) => (u.startsWith("/") ? base + u : u);
  const cited = [...body.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({ title: m[1], url: link(m[2]) }));
  const sources = [...sourcesBlock.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({ title: m[1], url: link(m[2]) }));
  const notCovered =
    /\b(docs?|documentation)\b[^.]{0,80}\b(don[’']t|do not|doesn[’']t|does not)\b[^.]{0,40}\b(provide|cover|describe|mention|include|document|specify)/i.test(body) ||
    /\b(can[’']t|cannot|unable to)\b[^.]{0,40}\b(give|provide|confirm|find)\b/i.test(body) ||
    /\bnot (documented|covered)\b/i.test(body);
  return { body: body.trim(), cited: dedupe(cited), sources: dedupe(sources), notCovered };
}

const dedupe = (xs) => [...new Map(xs.map((x) => [x.url.replace(/\/$/, ""), x])).values()];
