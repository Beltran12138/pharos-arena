// Alert rules and de-duplication, kept free of I/O so they can be tested without a chain or Telegram.
import { parseUnits } from "viem";
import { TOKENS, human, label, txLink, addrLink } from "../lib/pharos.mjs";

const BY_SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([a, t]) => [t.symbol, { address: a, ...t }]));

export function tokenOf(symbol) {
  const t = BY_SYMBOL[symbol];
  if (!t) throw new Error(`unknown token ${symbol}; known: ${Object.keys(BY_SYMBOL).join(", ")}`);
  return t;
}

/**
 * Transfer rule: one alert per Transfer log of `rule.token` with value ≥ rule.min.
 * The alert id is txHash:logIndex, so the same transfer can never alert twice.
 */
export function transferAlerts(rule, logs, decoded) {
  const t = tokenOf(rule.token);
  const min = parseUnits(String(rule.min), t.decimals);
  const out = [];
  logs.forEach((log, i) => {
    const { from, to, value } = decoded[i];
    if (value < min) return;
    out.push({
      id: `${rule.id}:${log.transactionHash}:${Number(BigInt(log.logIndex))}`,
      rule: rule.id,
      what: `Large ${t.symbol} transfer (≥ ${human(min, t.decimals)} ${t.symbol})`,
      value: `${human(value, t.decimals, 2)} ${t.symbol}`,
      detail: `${label(from)} → ${label(to)}, block ${Number(BigInt(log.blockNumber))}`,
      link: txLink(log.transactionHash),
    });
  });
  return out;
}

/**
 * Price rule: alert when the feed crosses rule.above or rule.below. After an alert the rule is disarmed and
 * re-arms only when the price has moved back past the threshold by rule.rearmPct (default 0.5%), so a price
 * hovering at the line does not alert on every poll. state = { armed } per rule, persisted by the caller.
 * The first observation counts: a rule whose condition already holds at start alerts once.
 */
export function priceAlert(rule, feed, state = { armed: true }) {
  const rearm = (rule.rearmPct ?? 0.5) / 100;
  const dir = rule.above != null ? "above" : "below";
  const line = rule[dir];
  const hit = dir === "above" ? feed.price >= line : feed.price <= line;
  const back = dir === "above" ? feed.price < line * (1 - rearm) : feed.price > line * (1 + rearm);
  if (!state.armed) return { state: { armed: back }, alert: null };
  if (!hit) return { state, alert: null };
  return {
    state: { armed: false },
    alert: {
      id: `${rule.id}:${feed.updatedAt}`,
      rule: rule.id,
      what: `${rule.pair} ${dir} ${line}`,
      value: `${rule.pair} = ${feed.price.toFixed(feed.price < 10 ? 4 : 2)} (Chainlink, updated ${new Date(feed.updatedAt * 1000).toISOString().slice(0, 19)}Z)`,
      detail: `feed ${feed.address}`,
      link: addrLink(feed.address),
    },
  };
}

/** Remembers delivered alert ids (bounded), so a restart or an overlapping poll never sends one twice. */
export class Seen {
  constructor(ids = [], max = 5000) {
    this.ids = new Set(ids);
    this.max = max;
  }
  has(id) {
    return this.ids.has(id);
  }
  add(id) {
    this.ids.add(id);
    while (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value);
  }
  toJSON() {
    return [...this.ids];
  }
}

export function format(a, html = false) {
  if (!html) return `${a.what}\n  value: ${a.value}\n  ${a.detail}\n  ${a.link}`;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<b>${esc(a.what)}</b>\nValue: ${esc(a.value)}\n${esc(a.detail)}\n<a href="${a.link}">View on PharosScan</a>`;
}
