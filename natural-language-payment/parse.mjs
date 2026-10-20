// Free text → { amount, symbol, recipient } plus the questions to ask when something is missing or ambiguous.
// Deterministic: no guessing. Anything that could mean two things becomes a question.

const TOKENS = ["PROS", "WPROS", "USDC", "LINK", "WETH"];
const AMBIGUOUS_TOKENS = {
  USD: "USDC (the only USD stablecoin this agent knows on Pharos)?",
  DOLLAR: "USDC (the only USD stablecoin this agent knows on Pharos)?",
  DOLLARS: "USDC (the only USD stablecoin this agent knows on Pharos)?",
  ETH: "WETH (wrapped ETH on Pharos)? The native token here is PROS, not ETH",
  PHRS: "PROS? PHRS is the testnet token; this agent works on mainnet",
};

/**
 * contacts: { name: address }. Returns { amount, symbol, recipient: { address, name } | null, memo, questions }.
 * questions: [{ field, ask, options? }] — empty when the request is complete and unambiguous.
 */
export function parse(text, contacts = {}) {
  const questions = [];
  const t = ` ${text.trim()} `;
  const memo = /\b(?:for|memo|ref(?:erence)?)\s+"([^"]+)"/i.exec(t)?.[1] ?? null;
  const body = memo ? t.replace(/\b(?:for|memo|ref(?:erence)?)\s+"[^"]+"/i, " ") : t;

  // Recipient: an address, a .eth name (no ENS on Pharos), or a contact name after "to"/"pay".
  let recipient = null;
  const addrs = body.match(/0x[0-9a-fA-F]{40}\b/g) ?? [];
  const malformed = (body.match(/0x[0-9a-zA-Z]+/g) ?? []).filter((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (addrs.length > 1) questions.push({ field: "recipient", ask: `Which address should receive it: ${addrs.join(" or ")}?`, options: addrs });
  else if (addrs.length === 1) recipient = { address: addrs[0], name: nameOf(addrs[0], contacts) };
  else if (malformed.length) questions.push({ field: "recipient", ask: `"${malformed[0]}" is not a full address (0x + 40 hex characters). What is the recipient's address?` });
  else {
    const ens = /\b([a-z0-9-]+\.eth)\b/i.exec(body)?.[1];
    const named = /\b(?:to|pay)\s+([a-z][\w-]*)/i.exec(body.replace(/\b[a-z0-9-]+\.eth\b/i, ""))?.[1];
    if (ens) {
      const base = ens.replace(/\.eth$/i, "").toLowerCase();
      const hit = contacts[base];
      questions.push({ field: "recipient", ask: `${ens} is an ENS name, and there is no ENS on Pharos.${hit ? ` Your contacts have "${base}" = ${hit}: is that the one?` : ""} What is the 0x address?`, options: hit ? [base] : undefined });
    } else if (named && !TOKENS.includes(named.toUpperCase())) {
      const key = named.toLowerCase();
      const matches = Object.keys(contacts).filter((c) => c === key || c.startsWith(key));
      if (contacts[key]) recipient = { address: contacts[key], name: key };
      else if (matches.length === 1) questions.push({ field: "recipient", ask: `By "${named}", do you mean your contact "${matches[0]}" (${contacts[matches[0]]})?`, options: matches });
      else if (matches.length > 1) questions.push({ field: "recipient", ask: `"${named}" matches several contacts: ${matches.join(", ")}. Which one?`, options: matches });
      else questions.push({ field: "recipient", ask: `"${named}" is not in your contacts. What is their 0x address?` });
    } else questions.push({ field: "recipient", ask: "Who should receive it? Give a 0x address or a contact name." });
  }

  // Amount: numbers not inside an address. "$5" counts as an amount with an ambiguous currency.
  const scrubbed = body.replace(/0x[0-9a-zA-Z]+/g, " ").replace(/\b[a-z0-9-]+\.eth\b/gi, " "); // addresses and ENS names are not amounts or tokens
  const nums = [...scrubbed.matchAll(/(?<![\w.])\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k|m)?\b/gi)];
  let amount = null;
  if (nums.length === 0) questions.push({ field: "amount", ask: "How much should be sent?" });
  else if (nums.length > 1) questions.push({ field: "amount", ask: `I see more than one amount (${nums.map((n) => n[0].trim()).join(", ")}). Which is the amount to send?`, options: nums.map((n) => n[0].trim()) });
  else {
    const [, int, frac = "", suffix] = nums[0];
    if (suffix) questions.push({ field: "amount", ask: `Is "${nums[0][0].trim()}" ${Number(int.replace(/,/g, "") + frac) * (suffix.toLowerCase() === "k" ? 1e3 : 1e6)}? Please give the exact number.` });
    else amount = int.replace(/,/g, "") + frac;
  }

  // Token.
  const words = scrubbed.toUpperCase().match(/[A-Z]+/g) ?? [];
  const known = [...new Set(words.filter((w) => TOKENS.includes(w)))];
  const vague = [...new Set(words.filter((w) => AMBIGUOUS_TOKENS[w]))];
  let symbol = null;
  if (known.length === 1 && !vague.length) symbol = known[0];
  else if (known.length > 1) questions.push({ field: "token", ask: `Which token: ${known.join(" or ")}?`, options: known });
  else if (vague.length) questions.push({ field: "token", ask: `By "${vague[0].toLowerCase()}", do you mean ${AMBIGUOUS_TOKENS[vague[0]]}`, options: [AMBIGUOUS_TOKENS[vague[0]].match(/^[A-Z]+/)[0]] });
  else if (/\$\d/.test(scrubbed)) questions.push({ field: "token", ask: `By "$", do you mean ${AMBIGUOUS_TOKENS.USD}`, options: ["USDC"] });
  else questions.push({ field: "token", ask: `Which token? (${TOKENS.join(", ")})`, options: TOKENS });

  return { amount, symbol, recipient, memo, questions };
}

function nameOf(address, contacts) {
  return Object.entries(contacts).find(([, a]) => a.toLowerCase() === address.toLowerCase())?.[0] ?? null;
}

/**
 * Apply the user's answer to one question. A yes ("y", "yes") picks the single offered option; an option
 * name, an address, an amount or a token symbol is taken as given. Returns the updated request.
 */
export function answer(req, q, reply, contacts = {}) {
  const r = reply.trim();
  const yes = /^(y|yes|yeah|correct|right)$/i.test(r);
  const pick = yes && q.options?.length === 1 ? q.options[0] : r;
  const next = { ...req };
  if (q.field === "recipient") {
    const addr = /^0x[0-9a-fA-F]{40}$/.test(pick) ? pick : contacts[pick.toLowerCase()];
    if (!addr) return { ...next, error: `"${r}" is neither a 0x address nor a contact` };
    next.recipient = { address: addr, name: nameOf(addr, contacts) };
  } else if (q.field === "amount") {
    const n = pick.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(n)) return { ...next, error: `"${r}" is not a number` };
    next.amount = n;
  } else if (q.field === "token") {
    const s = pick.toUpperCase();
    if (!TOKENS.includes(s)) return { ...next, error: `"${r}" is not one of ${TOKENS.join(", ")}` };
    next.symbol = s;
  }
  return next;
}
