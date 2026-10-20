// What the buyer may spend, and the ledger it keeps. Pure functions, tested on their own (test/x402.test.mjs).
//
// Amounts are USDC base units (bigint). A payment is identified by its EIP-3009 nonce: the same signed payment can
// settle at most once on chain, so retrying *the same* payment is safe, and the ledger never counts a nonce twice.
// A payment whose fate is unknown (signed, sent, no answer) is counted as spent until it is resolved — the budget
// is never exceeded by in-flight payments.

const usd = (x) => `$${Number(x) / 1e6}`;

/** May the agent pay `price` now? → { ok } or { ok: false, stop, why }. `stop`: no later item can fit either. */
export function canPay(price, { budget, cap }, ledger) {
  const p = BigInt(price);
  if (p > BigInt(cap)) return { ok: false, stop: false, why: `price ${usd(p)} is over the per-call cap ${usd(cap)}` };
  const committed = spent(ledger);
  if (committed + p > BigInt(budget)) return { ok: false, stop: true, why: `would bring the total to ${usd(committed + p)}, over the budget ${usd(budget)} (spent or in flight: ${usd(committed)})` };
  return { ok: true };
}

/** Total committed: settled payments plus payments still in flight, each nonce once. */
export function spent(ledger) {
  const byNonce = fold(ledger);
  let s = 0n;
  for (const p of Object.values(byNonce)) if (p.status === "settled" || p.status === "in-flight") s += BigInt(p.amount);
  return s;
}

/** Latest state per nonce. Entries: { nonce, amount, status: "in-flight" | "settled" | "not-settled", tx?, item } */
export function fold(ledger) {
  const out = {};
  for (const e of ledger) if (e.nonce) out[e.nonce] = { ...(out[e.nonce] ?? {}), ...e };
  return out;
}

/**
 * The plan's items in buying order: required first, then optional ones only while the budget allows. Items already
 * bought in this job (same resource) are not bought again. Once a required item could not be had (`requiredMissing`),
 * optional items are not worth buying: they are context for a report that can no longer be complete.
 */
export function nextItem(items, bought, requiredMissing = false) {
  const pending = items.filter((i) => !bought.has(i.resource));
  return pending.find((i) => i.required) ?? (requiredMissing ? null : pending.find((i) => !i.required)) ?? null;
}

/**
 * After a request with a payment failed or its answer was lost, what is true? `onChainUsed`: the token says the
 * nonce is used (authorizationState), so the payment settled whatever the server answered.
 */
export function resolveUnknown({ onChainUsed, attempts, rejectedStatus }, maxAttempts = 3) {
  if (onChainUsed) return { action: "record-settled", why: "the nonce is used on chain: the payment went through; count it once" };
  // A 4xx other than 402: the server refused the request itself; sending it again cannot help.
  if (rejectedStatus) return { action: "give-up", why: `the server rejected the request (${rejectedStatus}) and the nonce is unused: nothing was paid; count nothing` };
  if (attempts < maxAttempts) return { action: "resend-same", why: "the nonce is unused: resend the same signed payment (it can settle only once)" };
  return { action: "give-up", why: `nonce still unused after ${attempts} attempts: the payment did not happen; count nothing` };
}
