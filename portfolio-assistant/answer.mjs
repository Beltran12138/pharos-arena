// Natural-language questions about a portfolio snapshot. Pure: classify, then answer from the snapshot only.
// Every number in an answer comes with its sources; anything the snapshot does not contain is said, not guessed.

const usd = (x) => (x == null ? "unknown $" : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const amt = (x) => Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 4 });
const PROTOCOL_WORDS = { uniswap: "Uniswap", lp: "LP positions", aave: "Aave", compound: "Compound", curve: "Curve", staking: "staking", stake: "staking", pendle: "Pendle", nft: "NFTs" };

export function classify(q) {
  const t = q.toLowerCase();
  const other = Object.keys(PROTOCOL_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (other) return { intent: "notCovered", topic: PROTOCOL_WORDS[other] };
  if (/liquidat|health|at risk|\bsafe\b/.test(t)) return { intent: "risk" };
  if (/earn|yield|apy|interest|income|making|return/.test(t)) return { intent: "earning" };
  if (/biggest|largest|main position|most of my money/.test(t)) return { intent: "biggest" };
  if (/net worth|total (value|worth)|worth in total|portfolio (value|worth)|how much is (it|everything|my portfolio) worth/.test(t)) return { intent: "netWorth" };
  if (/\b(owe|debt|borrowed|loans?)\b/.test(t)) return { intent: "debt" };
  const where = /where (?:is|are) my (\w+)/.exec(t);
  if (where) return { intent: "where", token: where[1].toUpperCase() };
  const much = /how (?:much|many) (\w+)/.exec(t);
  if (much && !["is", "am", "do"].includes(much[1])) return { intent: "where", token: much[1].toUpperCase() };
  return { intent: "unknown" };
}

const cite = (r) => r.sources.filter(Boolean).map((s) => `      source: ${s}`).join("\n");

export function answer(q, s) {
  const c = classify(q);
  const head = `(wallet ${s.wallet}, block ${s.block}, ${s.time})`;
  const gaps = () => (s.unreadable.length ? `\n  Could not read: ${s.unreadable.map((u) => `${u.what} (${u.why})`).join("; ")}.` : "");
  const priced = s.rows.filter((r) => r.usd != null);
  const unpriced = s.rows.filter((r) => r.usd == null);

  if (c.intent === "notCovered")
    return `I can't read ${c.topic}: this assistant covers wallet balances, the vaults and the Morpho Blue markets in lib/protocols.json. I won't guess what you hold there. ${head}`;

  if (c.intent === "earning") {
    const lines = s.rows.filter((r) => r.apy != null || r.apyNote).map((r) => {
      const yearly = r.usd != null && r.apy != null ? r.usd * (r.apy / 100) : null;
      return `  ${r.debt ? "pays " : "earns"} ${r.apy != null ? `${r.apy.toFixed(2)}%` : "unknown"} on ${r.what} (${usd(Math.abs(r.usd ?? NaN) || null)})` +
        `${yearly != null ? ` → ${usd(yearly)}/year` : ""}${r.apyNote ? ` — ${r.apyNote}` : ""}\n${cite(r)}`;
    });
    const known = s.rows.filter((r) => r.apy != null && r.usd != null);
    const net = known.reduce((t, r) => t + r.usd * (r.apy / 100), 0);
    const silent = s.rows.filter((r) => r.apy == null && !r.apyNote && !r.debt);
    return `What you are earning ${head}:\n${lines.join("\n")}\n  Net, at today's rates: ${usd(net)}/year` +
      `${silent.length ? `\n  Earning nothing that I can see: ${silent.map((r) => r.what).join(", ")}.` : ""}` +
      `\n  Rates: vault APY = share-price growth over the last 7 days, annualized; Morpho = current IRM rate × utilization. Both change.${gaps()}`;
  }

  if (c.intent === "biggest") {
    const top = [...priced].filter((r) => !r.debt).sort((a, b) => b.usd - a.usd);
    if (!top.length) return `I see no priced position ${head}.${gaps()}`;
    const r = top[0];
    return `Your biggest position is ${r.what}: ${amt(r.amount)} ${r.asset} ≈ ${usd(r.usd)} ${head}\n${cite(r)}` +
      `${top[1] ? `\n  Next: ${top[1].what} ≈ ${usd(top[1].usd)}.` : ""}${unpriced.length ? `\n  Not ranked (no price): ${unpriced.map((x) => x.what).join(", ")}.` : ""}`;
  }

  if (c.intent === "netWorth") {
    const assets = priced.filter((r) => !r.debt).reduce((t, r) => t + r.usd, 0);
    const debts = priced.filter((r) => r.debt).reduce((t, r) => t + r.usd, 0);
    return `Net worth ≈ ${usd(assets + debts)} ${head}: assets ${usd(assets)}, debts ${usd(debts)}.\n` +
      priced.map((r) => `  ${r.what}: ${usd(r.usd)}\n${cite(r)}`).join("\n") +
      `${unpriced.length ? `\n  Not included (no price): ${unpriced.map((x) => x.what).join(", ")}.` : ""}\n  Not covered at all: ${s.notCovered.join("; ")}.${gaps()}`;
  }

  if (c.intent === "debt" || c.intent === "risk") {
    const debts = s.rows.filter((r) => r.debt);
    if (!debts.length) return `You have no debt in the Morpho markets I read ${head}.${gaps()}`;
    return `${c.intent === "risk" ? "Liquidation risk" : "What you owe"} ${head}:\n` + debts.map((r) =>
      `  ${r.what}: ${amt(r.amount)} ${r.asset} (${usd(r.usd)}) at ${r.apy.toFixed(2)}% — health factor ${r.healthFactor.toFixed(4)} (liquidation below 1, LLTV ${r.lltv}%)` +
      `; ${r.healthFactor < 1.1 ? "CLOSE to liquidation" : r.healthFactor < 1.3 ? "watch it" : "comfortable"}; the collateral can fall ${((1 - 1 / r.healthFactor) * 100).toFixed(1)}% before liquidation\n${cite(r)}`).join("\n") + gaps();
  }

  if (c.intent === "where") {
    const tok = c.token === "DOLLARS" ? "USDC" : c.token;
    const hits = s.rows.filter((r) => r.asset === tok);
    if (!hits.length) return `I don't see any ${tok} in the places I can read ${head}. That does not rule out ${tok} elsewhere: ${s.notCovered.join("; ")}.${gaps()}`;
    const total = hits.reduce((t, r) => t + r.amount, 0);
    return `Your ${tok} ${head}:\n` + hits.map((r) => `  ${r.debt ? "owed" : "held"}: ${amt(r.amount)} ${tok} — ${r.what}\n${cite(r)}`).join("\n") + `\n  Net ${tok}: ${total.toLocaleString("en-US", { maximumFractionDigits: 4 })}.${gaps()}`;
  }

  return `I don't understand that question, so I won't guess. I can answer: what am I earning? · where is my <token>? · how much <token> do I have? · what's my biggest position? · what's my net worth? · what do I owe? · am I at risk of liquidation?`;
}
