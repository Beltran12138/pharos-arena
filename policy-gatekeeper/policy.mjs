// Policy evaluation: pure, no I/O. Given a policy, a requested action, the time it is requested at and
// what was already spent today, return allow/deny and the rule that decided it.
import { decodeFunctionData, parseAbi, parseUnits, toFunctionSelector } from "viem";
import { TOKENS } from "../lib/pharos.mjs";

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
]);

const lc = (a) => a.toLowerCase();

/**
 * What an action moves, and to whom. Native value is always spend. An ERC-20 transfer/transferFrom on a
 * known token is spend of that token to its `to`; an approve names a spender that must be allowlisted.
 */
export function describe(action) {
  const to = lc(action.to);
  const out = { to, selector: null, spends: [], counterparties: [] };
  const value = BigInt(action.valueWei ?? "0");
  if (value > 0n) out.spends.push({ symbol: "PROS", decimals: 18, amount: value });
  if (!action.data || action.data === "0x") {
    out.counterparties.push({ role: "recipient", address: to });
    return out;
  }
  out.selector = action.data.slice(0, 10).toLowerCase();
  const token = TOKENS[to];
  if (token) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: ERC20, data: action.data });
      if (functionName === "transfer" || functionName === "transferFrom") {
        const dest = lc(functionName === "transfer" ? args[0] : args[1]);
        const amount = functionName === "transfer" ? args[1] : args[2];
        out.spends.push({ symbol: token.symbol, decimals: token.decimals, amount });
        out.counterparties.push({ role: "recipient", address: dest });
      } else if (functionName === "approve") {
        out.counterparties.push({ role: "spender", address: lc(args[0]) });
      }
    } catch {
      // not one of the ERC-20 functions above: a plain contract call
    }
  }
  return out;
}

/** Normalise policy addresses/selectors once. */
export function compile(policy) {
  const contracts = {};
  for (const [addr, fns] of Object.entries(policy.allowlist.contracts ?? {})) {
    contracts[lc(addr)] = new Set(fns.map((f) => (f.startsWith("0x") ? lc(f) : toFunctionSelector(`function ${f}`))));
  }
  const limit = (m) =>
    Object.fromEntries(
      Object.entries(m ?? {}).map(([sym, v]) => [sym, parseUnits(v, sym === "PROS" ? 18 : decimalsOf(sym))]),
    );
  return {
    recipients: new Set((policy.allowlist.recipients ?? []).map(lc)),
    contracts,
    perTx: limit(policy.spendLimit.perTx),
    perDay: limit(policy.spendLimit.perDay),
    windows: policy.timeWindows,
  };
}

function decimalsOf(symbol) {
  const t = Object.values(TOKENS).find((t) => t.symbol === symbol);
  if (!t) throw new Error(`unknown token in policy: ${symbol}`);
  return t.decimals;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function inWindow(windows, at) {
  const day = DAYS[at.getUTCDay()];
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return windows.find((w) => {
    if (!w.days.includes(day)) return false;
    const [fh, fm] = w.from.split(":").map(Number);
    const [th, tm] = w.to.split(":").map(Number);
    return minutes >= fh * 60 + fm && minutes < th * 60 + tm;
  });
}

/**
 * @param compiled  compile(policy)
 * @param action    { to, valueWei?, data? }
 * @param at        Date the action is requested at
 * @param spentToday { [symbol]: bigint } already allowed today (UTC)
 * @returns { decision, rule, reason, checks[] } — `rule` is the first rule that denied, or null on allow.
 */
export function evaluate(compiled, action, at, spentToday = {}) {
  const d = describe(action);
  const checks = [];
  const add = (rule, ok, detail) => checks.push({ rule, ok, detail });

  // 1. allowlist
  if (d.selector) {
    const fns = compiled.contracts[d.to];
    if (!fns) add("allowlist.contract", false, `contract ${d.to} is not on the allowlist`);
    else if (!fns.has(d.selector)) add("allowlist.function", false, `function ${d.selector} is not allowed on ${d.to}`);
    else add("allowlist.contract", true, `${d.selector} on ${d.to} is allowed`);
  }
  for (const c of d.counterparties) {
    const ok = compiled.recipients.has(c.address);
    add(`allowlist.${c.role}`, ok, `${c.role} ${c.address} is ${ok ? "" : "not "}on the allowlist`);
  }

  // 2. time window
  const w = inWindow(compiled.windows, at);
  add(
    "timeWindow",
    Boolean(w),
    w ? `${at.toISOString()} is inside "${w.name}"` : `${at.toISOString()} is outside every allowed window`,
  );

  // 3. spend limits
  for (const s of d.spends) {
    const perTx = compiled.perTx[s.symbol];
    const perDay = compiled.perDay[s.symbol];
    if (perTx === undefined || perDay === undefined) {
      add("spendLimit.perTx", false, `no spend limit is set for ${s.symbol}, so it cannot be spent`);
      continue;
    }
    add("spendLimit.perTx", s.amount <= perTx, `${fmt(s.amount, s)} vs per-tx limit ${fmt(perTx, s)}`);
    const after = (spentToday[s.symbol] ?? 0n) + s.amount;
    add("spendLimit.perDay", after <= perDay, `${fmt(after, s)} today incl. this vs daily limit ${fmt(perDay, s)}`);
  }

  const failed = checks.find((c) => !c.ok);
  return {
    decision: failed ? "deny" : "allow",
    rule: failed?.rule ?? null,
    reason: failed?.detail ?? "all rules passed",
    spends: d.spends.map((s) => ({ symbol: s.symbol, amount: s.amount.toString() })),
    checks,
  };
}

function fmt(v, s) {
  const str = v.toString().padStart(s.decimals + 1, "0");
  const i = str.slice(0, -s.decimals) || "0";
  const f = str.slice(-s.decimals).replace(/0+$/, "");
  return `${i}${f ? "." + f : ""} ${s.symbol}`;
}

