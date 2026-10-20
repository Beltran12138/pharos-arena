// Turn a Docs MCP answer into an executable plan, without adding anything the docs did not say.
//
// The steps come from the commands the docs answer itself gives (`cast call`, `cast send`, a JSON-RPC request in a
// curl body). Placeholders in them (<ADDRESS>, <TRANSACTION_HASH>, …) are filled from the user's request only.
// Every contract address and function in a step must then be found in the text of a docs page fetched with getPage
// (the askQuestion answer is itself generated, so it is not a source on its own); ERC-20 functions count as
// grounded on an address the docs list as a token. A step that is not grounded is not executed.
import { parseAbi, parseEther, parseUnits } from "viem";

/** Code blocks of an answer, with shell line continuations joined. */
export function codeBlocks(body) {
  // `# comments` are dropped first, so they don't become arguments.
  return [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\s+#[^\n'"]*$/gm, "").replace(/\\\n\s*/g, " ").trim());
}

/** Minimal shell tokenizer: whitespace-separated words, '…' and "…" quoted. */
export function words(line) {
  const out = [];
  for (const m of line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `name(types)(outputs)` (cast form) → a viem ABI item. */
export function castSig(sig) {
  const m = /^(\w+)\(([^)]*)\)(?:\(([^)]*)\))?$/.exec(sig.trim());
  if (!m) throw new Error(`not a function signature: ${sig}`);
  const [, name, ins, outs] = m;
  return parseAbi([`function ${name}(${ins}) ${outs != null ? `view returns (${outs})` : ""}`.trim()])[0];
}

/** cast --value: "0.01ether", "10gwei", "1000" (wei). */
export function castValue(v) {
  const m = /^([\d.]+)\s*(ether|gwei|wei)?$/.exec(v);
  if (!m) throw new Error(`cannot read --value ${v}`);
  return m[2] === "ether" ? parseEther(m[1]) : m[2] === "gwei" ? parseUnits(m[1], 9) : BigInt(m[1]);
}

/**
 * Steps from the commands in the answer:
 *   { kind: "call", to, fn, args, rpc }            cast call
 *   { kind: "send", to, value, fn?, args, rpc }    cast send (moves funds → prepared, never signed here)
 *   { kind: "rpc", method, params, rpc }           curl … -d '{"method": …}'
 *   { kind: "code", to, rpc }                      cast code (read-only)
 */
export function stepsFrom(body) {
  const steps = [];
  for (const raw of codeBlocks(body)) {
    // Shell variables set in the same block (export RPC=https://…) are substituted; others ($PRIVATE_KEY) stay.
    const vars = Object.fromEntries([...raw.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)/gm)].map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
    const block = raw.replace(/"?\$\{?([A-Za-z_]\w*)\}?"?/g, (m, v) => (v in vars ? vars[v] : m));
    // A block can hold several commands; split on newlines that start a new command.
    for (const cmd of block.split(/\n(?=\s*(?:cast|curl)\b)/)) {
      const w = words(cmd.replace(/\n/g, " "));
      const flag = (f) => (w.includes(f) ? w[w.indexOf(f) + 1] : undefined);
      if (w[0] === "cast" && (w[1] === "call" || w[1] === "send")) {
        const pos = [];
        for (let i = 2; i < w.length; i++) {
          if (w[i].startsWith("--")) { i++; continue; }
          pos.push(w[i]);
        }
        const [to, sig, ...args] = pos;
        const step = { kind: w[1], to, fn: sig ? castSig(sig) : null, args, rpc: flag("--rpc-url"), command: cmd.replace(/\s+/g, " ").trim() };
        if (w[1] === "send") step.value = castValue(flag("--value") ?? "0");
        steps.push(step);
      } else if (w[0] === "cast" && w[1] === "code") {
        steps.push({ kind: "code", to: w[2], args: [], rpc: flag("--rpc-url"), command: cmd.replace(/\s+/g, " ").trim() });
      } else if (w[0] === "curl") {
        const body = flag("-d") ?? flag("--data");
        let j;
        try { j = JSON.parse(body); } catch { continue; }
        if (j?.method) steps.push({ kind: "rpc", method: j.method, params: j.params ?? [], rpc: w.find((x) => /^https?:\/\//.test(x)), command: cmd.replace(/\s+/g, " ").trim() });
      }
    }
  }
  return steps;
}

const WORDS = { six: 6, eight: 8, nine: 9, twelve: 12, eighteen: 18 };
/** The decimals the answer claims for a raw value: "18 decimals", "six decimal places", "divide … by 1,000,000", "10^18". */
export function decimalsClaim(body) {
  const t = body.replace(/\*\*|`/g, "");
  const n = /\b(\d{1,2}|six|eight|nine|twelve|eighteen)[\s-]+decimal/i.exec(t)?.[1];
  if (n) return WORDS[n.toLowerCase()] ?? Number(n);
  const div = /divide[^.]{0,30}?\bby\s+(1(?:,?000)+|10\^(\d{1,2}))\b/i.exec(t);
  if (div) return div[2] ? Number(div[2]) : div[1].replace(/,/g, "").length - 1;
  return null;
}

const ADDR = /\b0x[0-9a-fA-F]{40}\b/g;
const HASH = /\b0x[0-9a-fA-F]{64}\b/g;

/** What the user's request supplies: addresses, transaction hashes, an amount with its token. */
export function requestInputs(q) {
  const hashes = q.match(HASH) ?? [];
  const addresses = (q.replace(HASH, "").match(ADDR) ?? []);
  const amt = /(\d+(?:\.\d+)?)\s*(PROS|USDC|WPROS)\b/i.exec(q);
  return { addresses, hashes, amount: amt ? { value: amt[1], symbol: amt[2].toUpperCase() } : null };
}

/**
 * Fill <PLACEHOLDER> words from the request. Returns { step, missing: [placeholder…] }; an address placeholder
 * takes the request's first address, a hash placeholder its first hash. Nothing is invented: no input → missing.
 */
export function fill(step, inputs) {
  const missing = [];
  const sub = (x) => {
    if (typeof x !== "string" || !/^<[^>]+>$/.test(x)) return x;
    if (/hash|tx/i.test(x) && inputs.hashes[0]) return inputs.hashes[0];
    if (/addr|recipient|account|wallet|to/i.test(x) && inputs.addresses[0]) return inputs.addresses[0];
    missing.push(x);
    return x;
  };
  return { step: { ...step, to: sub(step.to), args: step.args?.map(sub), params: step.params?.map(sub) }, missing };
}

export const ERC20_FNS = new Set(["balanceOf", "decimals", "symbol", "name", "totalSupply", "allowance", "transfer", "approve", "transferFrom"]);

/**
 * Where each fact of a step comes from. `pages` are { url, text } from getPage; `caveats` are the answer's own
 * sentences saying something is not documented. Returns [{ fact, source, where }] with source one of
 *   "page" | "standard" | "request"       grounded
 *   "answer only" | "disclaimed"           not grounded: the step does not run
 * A function counts only on a page that also lists the contract: a `deposit(` on another contract's page (the
 * Piggy Bank tutorial) says nothing about WPROS. A function the answer itself calls unconfirmed is "disclaimed".
 */
export function ground(step, pages, inputs, caveats = []) {
  const lower = pages.map((p) => ({ url: p.url, text: p.text.toLowerCase() }));
  const onPage = (s, also) => lower.find((p) => p.text.includes(String(s).toLowerCase()) && (!also || p.text.includes(also.toLowerCase())))?.url;
  const fromRequest = (s) => inputs.addresses.some((a) => a.toLowerCase() === String(s).toLowerCase()) || inputs.hashes.includes(s);
  const out = [];
  const add = (fact, value) => {
    if (fromRequest(value)) return out.push({ fact, value, source: "request" });
    const url = onPage(value);
    out.push(url ? { fact, value, source: "page", where: url } : { fact, value, source: "answer only" });
  };
  if (step.kind === "rpc") {
    add("JSON-RPC method", step.method);
    step.params.forEach((p, i) => typeof p === "string" && /^0x/.test(p) && add(`param ${i}`, p));
  } else {
    add(step.kind === "send" && !step.fn ? "recipient" : "contract", step.to);
    if (step.fn) {
      const contract = out[out.length - 1];
      // ERC-20 is a standard: its functions are grounded on a contract the docs list (Token Registry).
      const name = step.fn.name;
      const caveat = caveats.find((c) => new RegExp(`\\b${name}\\b`).test(c));
      if (caveat) out.push({ fact: "function", value: name, source: "disclaimed", where: `the answer says: "${caveat}"` });
      else if (ERC20_FNS.has(name) && contract.source === "page") out.push({ fact: "function", value: name, source: "standard", where: "EIP-20, on a token the docs list" });
      else {
        const url = onPage(`${name}(`, step.to);
        const elsewhere = onPage(`${name}(`);
        out.push(url ? { fact: "function", value: name, source: "page", where: url } : { fact: "function", value: name, source: "answer only", ...(elsewhere ? { where: `only on ${elsewhere}, which does not list ${step.to}` } : {}) });
      }
    }
    step.args.forEach((a, i) => /^0x/.test(a) && add(`argument ${i}`, a));
  }
  if (step.rpc) add("RPC endpoint", step.rpc);
  return out;
}

/** Chain MCP tool for a JSON-RPC method the docs name, with its arguments. */
export const RPC_TO_MCP = {
  eth_getTransactionReceipt: (p) => ["get_transaction_receipt", { hash: p[0] }],
  eth_getTransactionByHash: (p) => ["get_transaction", { hash: p[0] }],
  eth_getBalance: (p) => ["get_balance", { address: p[0], ...(p[1] ? { block: p[1] } : {}) }],
  eth_blockNumber: () => ["get_block_number", {}],
  eth_gasPrice: () => ["get_gas_price", {}],
  eth_getCode: (p) => ["get_code", { address: p[0] }],
};
