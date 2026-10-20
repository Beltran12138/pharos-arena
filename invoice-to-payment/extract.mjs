// Invoice → a normalized payment request, from three formats: plain text, JSON, and an EIP-681 payment URI.
// Then checks that flag what is missing or inconsistent. Pure: the chain checks happen in invoice.mjs.

const TOKENS = { PROS: 18, WPROS: 18, USDC: 6, LINK: 18, WETH: 18 };
const ADDRESS = /0x[0-9a-fA-F]{40}\b/;

/** Detect the format from the content. */
export function detect(text) {
  const t = text.trim();
  if (t.startsWith("ethereum:")) return "eip681";
  if (t.startsWith("{")) return "json";
  return "text";
}

export function extract(text) {
  const format = detect(text);
  const inv = format === "json" ? fromJson(JSON.parse(text)) : format === "eip681" ? fromUri(text.trim()) : fromText(text);
  return { format, ...inv };
}

/** Plain-text invoice, labels matched case-insensitively ("Invoice No:", "Pay to:", "Total due:", …). */
function fromText(text) {
  const line = (re) => text.split(/\r?\n/).map((l) => re.exec(l)).find(Boolean);
  const reference = line(/\binvoice\s*(?:no\.?|number|#|id)\s*[:#]?\s*([A-Z0-9][\w-]*)/i)?.[1] ?? null;
  const payeeName = line(/^\s*(?:from|vendor|seller|issued by|bill from)\s*:\s*(.+?)\s*$/i)?.[1] ?? null;
  const payTo = line(/\b(?:pay to|payee address|wallet|send to|payment address)\s*:?\s*(0x\w+)/i)?.[1] ?? null;
  const total = line(/\btotal(?:\s+due)?\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]+)?/i);
  const due = line(/\bdue(?:\s+date)?\s*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
  const chain = line(/\bchain\s*(?:id)?\s*:\s*(\d+)/i)?.[1] ?? null;
  const network = line(/\bnetwork\s*:\s*(.+?)\s*$/i)?.[1] ?? null;
  const items = text
    .split(/\r?\n/)
    .map((l) => /^\s*(.+?)\s+(\d+(?:\.\d+)?)\s*x\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]+)?\s*=\s*([\d,]+(?:\.\d+)?)/i.exec(l))
    .filter(Boolean)
    .map((m) => ({ description: m[1].trim(), quantity: num(m[2]), unitPrice: num(m[3]), amount: num(m[5]), currency: m[4]?.toUpperCase() ?? null }));
  return {
    reference,
    payee: { name: payeeName, address: payTo },
    total: total ? num(total[1]) : null,
    currency: total?.[2]?.toUpperCase() ?? items.find((i) => i.currency)?.currency ?? null,
    items,
    dueDate: due,
    chainId: chain ? Number(chain) : /pharos/i.test(network ?? "") ? 1672 : null,
    network,
  };
}

/** JSON invoice. Accepts common field names (invoiceNumber/reference/id, seller/vendor/payee, …). */
function fromJson(j) {
  const pick = (o, ...ks) => ks.map((k) => k.split(".").reduce((x, p) => x?.[p], o)).find((v) => v != null) ?? null;
  const items = (pick(j, "lineItems", "items", "lines") ?? []).map((i) => ({
    description: pick(i, "description", "name"),
    quantity: num(pick(i, "quantity", "qty") ?? 1),
    unitPrice: num(pick(i, "unitPrice", "price")),
    amount: num(pick(i, "amount", "total") ?? num(pick(i, "quantity", "qty") ?? 1) * num(pick(i, "unitPrice", "price"))),
  }));
  const total = pick(j, "total", "amountDue", "totalDue", "amount");
  return {
    reference: pick(j, "invoiceNumber", "reference", "invoiceId", "id"),
    payee: { name: pick(j, "seller.name", "vendor.name", "payee.name", "from"), address: pick(j, "seller.wallet", "seller.address", "vendor.wallet", "payee.address", "payTo") },
    total: total == null ? null : num(total),
    currency: pick(j, "currency", "token")?.toUpperCase() ?? null,
    items,
    dueDate: pick(j, "dueDate", "due"),
    chainId: pick(j, "chainId", "network.chainId") == null ? null : Number(pick(j, "chainId", "network.chainId")),
    network: pick(j, "network.name", "network"),
  };
}

/**
 * EIP-681 payment request: ethereum:<token>@<chainId>/transfer?address=<payee>&uint256=<raw> (ERC-20) or
 * ethereum:<payee>@<chainId>?value=<wei> (native). The reference is read from a `ref`/`reference`/`memo` param.
 */
function fromUri(uri) {
  const m = /^ethereum:(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/(\w+))?(?:\?(.*))?$/.exec(uri);
  if (!m) return { reference: null, payee: { name: null, address: null }, total: null, currency: null, items: [], dueDate: null, chainId: null, parseError: `not an EIP-681 URI: ${uri}` };
  const q = new URLSearchParams(m[4] ?? "");
  const erc20 = m[3] === "transfer";
  return {
    reference: q.get("ref") ?? q.get("reference") ?? q.get("memo"),
    payee: { name: q.get("label"), address: erc20 ? q.get("address") : m[1] },
    tokenAddress: erc20 ? m[1].toLowerCase() : null,
    rawAmount: erc20 ? q.get("uint256") : q.get("value"),
    total: null, // filled from the raw amount once the token is known
    currency: erc20 ? null : "PROS",
    items: [],
    dueDate: q.get("due"),
    chainId: m[2] ? Number(m[2]) : null,
  };
}

const num = (v) => (v == null ? null : Number(String(v).replace(/,/g, "")));

/**
 * Checks: { level: "error"|"warn", field, detail }. Errors block the payment. Nothing is filled in by
 * guessing: a missing or contradictory field is reported, not repaired.
 * ctx: { vendors: {name: address}, tokens: {address: symbol}, today: "YYYY-MM-DD", prepared: Map(ref → when) }
 */
export function check(inv, ctx) {
  const out = [];
  const err = (field, detail) => out.push({ level: "error", field, detail });
  const warn = (field, detail) => out.push({ level: "warn", field, detail });
  if (inv.parseError) err("format", inv.parseError);

  // EIP-681: the token comes from the contract address in the URI.
  if (inv.tokenAddress) {
    const sym = ctx.tokens[inv.tokenAddress];
    if (!sym) err("currency", `token contract ${inv.tokenAddress} is not a known Pharos token`);
    else Object.assign(inv, { currency: sym, total: Number(inv.rawAmount) / 10 ** TOKENS[sym] });
  } else if (inv.rawAmount != null && inv.currency === "PROS") inv.total = Number(inv.rawAmount) / 1e18;

  if (!inv.reference) err("reference", "no invoice number / reference found");
  if (!inv.payee.address) err("payee", "no payee wallet address found");
  else if (!ADDRESS.test(inv.payee.address) || inv.payee.address.length !== 42) err("payee", `"${inv.payee.address}" is not a 0x address`);
  // An unknown token contract already explains why there is no amount or currency: do not report it three times.
  const unknownToken = inv.tokenAddress && !ctx.tokens[inv.tokenAddress];
  if (!unknownToken && (inv.total == null || !(inv.total > 0))) err("amount", "no total amount found");
  if (!unknownToken && !inv.currency) err("currency", "no currency or token stated");
  else if (inv.currency && !TOKENS[inv.currency]) err("currency", `"${inv.currency}" is not a token: say which token to pay in (e.g. USDC for USD)`);

  if (inv.items.length && inv.total != null) {
    const sum = inv.items.reduce((s, i) => s + i.amount, 0);
    if (Math.abs(sum - inv.total) > 1e-9) err("amount", `line items add up to ${round(sum)}, but the total says ${inv.total}`);
    for (const i of inv.items) {
      if (i.unitPrice != null && i.quantity != null && Math.abs(i.quantity * i.unitPrice - i.amount) > 1e-9) err("amount", `"${i.description}": ${i.quantity} × ${i.unitPrice} = ${round(i.quantity * i.unitPrice)}, not ${i.amount}`);
      if (i.currency && inv.currency && i.currency !== inv.currency) err("currency", `"${i.description}" is in ${i.currency}, the total in ${inv.currency}`);
    }
  }
  if (inv.chainId != null && inv.chainId !== 1672) err("network", `invoice asks for chain ${inv.chainId}; this agent pays on Pharos mainnet (1672)`);
  if (inv.chainId == null) warn("network", "no network stated; preparing on Pharos mainnet (1672)");

  // The payee name is a known vendor but the address is not theirs: a classic invoice-redirection fraud.
  const known = inv.payee.name && Object.entries(ctx.vendors).find(([n]) => n.toLowerCase() === inv.payee.name.toLowerCase());
  if (known && inv.payee.address && known[1].toLowerCase() !== inv.payee.address.toLowerCase())
    err("payee", `"${known[0]}" is on file with ${known[1]}, but this invoice says pay ${inv.payee.address}`);
  if (!known && inv.payee.address) warn("payee", `payee${inv.payee.name ? ` "${inv.payee.name}"` : ""} is not in vendors.json: check the address with them another way`);

  if (inv.dueDate && inv.dueDate < ctx.today) warn("due", `due ${inv.dueDate}, already past`);
  if (inv.reference && ctx.prepared.has(inv.reference)) err("reference", `invoice ${inv.reference} was already prepared for payment on ${ctx.prepared.get(inv.reference)}`);
  return out;
}

const round = (x) => Math.round(x * 1e9) / 1e9;
