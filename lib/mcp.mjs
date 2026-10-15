// Thin client for the Pharos Chain MCP server (hosted, read-only, Streamable HTTP).
// Every chain read in this repo goes through here, so each build really uses Chain MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";

export async function connect() {
  const client = new Client({ name: "pharos-arena", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
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

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
