// Schedule calendar and payment-instance state, from an append-only ledger. Pure: no chain access.

const DAY = 86400;

/** Due times (unix s) of a schedule from its start up to `now`, inclusive. Monthly keeps the start's day of
 * month, clamped to the month's last day (a schedule starting on the 31st pays on Feb 28/29). */
export function dueTimes(s, now) {
  const start = Date.parse(`${s.start}T${s.time ?? "00:00"}:00Z`) / 1000;
  const out = [];
  for (let k = 0; ; k++) {
    const t = nth(s, start, k);
    if (t > now) break;
    out.push(t);
  }
  return out;
}

/** The first due time after `now`. */
export function nextDue(s, now) {
  const start = Date.parse(`${s.start}T${s.time ?? "00:00"}:00Z`) / 1000;
  for (let k = 0; ; k++) {
    const t = nth(s, start, k);
    if (t > now) return t;
  }
}

function nth(s, start, k) {
  if (s.every === "weekly") return start + k * 7 * DAY;
  if (s.every === "monthly") {
    const d = new Date(start * 1000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + k, day = d.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes()) / 1000;
  }
  throw new Error(`schedule ${s.id}: every must be "weekly" or "monthly", got ${s.every}`);
}

export const instanceId = (s, t) => `${s.id}@${new Date(t * 1000).toISOString().slice(0, 10)}`;

/**
 * Fold ledger events into the state of each instance:
 * { status: "paid"|"pending"|"failed", attempts, prepared?: {nonce, file}, tx?, reason? }.
 * Events: prepared {nonce,file} · failed {reason} · paid {tx} · stale {nonce} (prepared tx can no longer land).
 */
export function fold(events) {
  const st = {};
  for (const e of events) {
    const s = (st[e.instance] ??= { status: "due", attempts: 0, history: [] });
    s.history.push(e);
    if (e.event === "prepared") Object.assign(s, { status: "pending", prepared: { nonce: e.nonce, file: e.file }, attempts: s.attempts + 1 });
    else if (e.event === "failed") Object.assign(s, { status: "failed", reason: e.reason, attempts: s.attempts + 1, prepared: undefined });
    else if (e.event === "unconfirmed") s.status = "unconfirmed"; // keeps the prepared tx; never re-prepared by itself
    else if (e.event === "stale") Object.assign(s, { status: "due", prepared: undefined });
    else if (e.event === "paid") Object.assign(s, { status: "paid", tx: e.tx, prepared: undefined });
  }
  return st;
}

/** On-chain transfers already credited to some instance: one transfer pays at most one instance. */
export const usedTxs = (events) => new Set(events.filter((e) => e.event === "paid").map((e) => `${e.tx}:${e.logIndex ?? -1}`));

/**
 * The earliest on-chain transfer that pays this instance: same token, from the payer to the recipient, exact
 * amount, at or after the due time, not already credited to another instance.
 */
export function matchPayment(transfers, { token, to, raw, dueAt }, used) {
  return transfers
    .filter((t) => t.token === token && t.to === to.toLowerCase() && t.value === raw && t.time >= dueAt && !used.has(`${t.tx}:${t.logIndex ?? -1}`))
    .sort((a, b) => a.time - b.time)[0];
}
