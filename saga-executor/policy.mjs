// Saga policy: what a failure means and what to do next. Pure functions, no chain access, so they are tested
// on their own (test/saga.test.mjs).
//
// A step goes  pending → simulated → signed → sent → confirmed → verified.
// Transient failures are retried in place; a permanent failure starts compensation: the verified steps are
// undone in reverse order (each compensation is itself a step with the same retry policy). If retries run out on a
// transient cause, the saga pauses (resumable) instead of compensating: undoing at a gas spike costs the same spike.

export const POLICY = {
  gasCapWei: 50n * 10n ** 9n, // don't send above 50 gwei (the network sits at 10 gwei); wait for it to come back
  gasWaitMs: 15_000,
  gasWaitMax: 40, // 10 minutes of a spike, then pause
  rpcRetries: 4, // network / 429 / 5xx on a call or a broadcast, with backoff
  rpcBackoffMs: 2_000,
  receiptWaitMs: 45_000, // no receipt in this time and the node doesn't know the tx → dropped
  rebroadcasts: 2, // the same signed bytes, sent again
  replacements: 2, // then re-signed with the same nonce at +25% gas price
  bumpPct: 25n,
};

/** transient: retry the same thing; permanent: this step cannot succeed as defined → compensate. */
export function classify(err) {
  const m = String(err?.message ?? err);
  if (/execution reverted|revert|insufficient funds|invalid opcode|out of gas|market not created|nonce too low/i.test(m)) return "permanent";
  if (/429|too many requests|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket|5\d\d|bad gateway|unavailable|<html|unexpected token/i.test(m)) return "transient";
  return "permanent";
}

/** Gas price check before signing: send, or wait (spike), or pause after waiting too long. */
export function gasDecision(gasPriceWei, waited, p = POLICY) {
  if (BigInt(gasPriceWei) <= p.gasCapWei) return { action: "send" };
  if (waited < p.gasWaitMax) return { action: "wait", why: `gas ${Number(BigInt(gasPriceWei) / 10n ** 9n)} gwei > cap ${Number(p.gasCapWei / 10n ** 9n)} gwei` };
  return { action: "pause", why: `gas stayed above ${Number(p.gasCapWei / 10n ** 9n)} gwei for ${(waited * p.gasWaitMs) / 60000} min` };
}

/**
 * A sent transaction without a receipt after the wait. `known`: the node returns it; `nonceUsed`: the account nonce
 * moved past it (another tx with this nonce was mined, or this one was and the receipt read failed).
 */
export function droppedDecision({ known, nonceUsed, rebroadcasts, replacements }, p = POLICY) {
  if (nonceUsed) return { action: "reconcile", why: "the nonce is used: look for which transaction took it" };
  if (known) return { action: "wait", why: "the node has it pending" };
  if (rebroadcasts < p.rebroadcasts) return { action: "rebroadcast", why: "dropped: the node does not know it; send the same signed bytes again" };
  if (replacements < p.replacements) return { action: "replace", why: `still dropped: re-sign with the same nonce at +${p.bumpPct}% gas price` };
  return { action: "pause", why: "dropped after every rebroadcast and replacement" };
}

/** Replacement gas price: +bump% of the old one, at least the current network price. */
export function bumped(oldWei, networkWei, p = POLICY) {
  const b = (BigInt(oldWei) * (100n + p.bumpPct) + 99n) / 100n;
  return b > BigInt(networkWei) ? b : BigInt(networkWei);
}

/** The state of a saga from its log: per step the last state, the overall phase, and what to do next. */
export function fold(entries) {
  const steps = {};
  let phase = "running";
  let failure = null;
  for (const e of entries) {
    if (e.step) steps[e.step] = { ...(steps[e.step] ?? {}), state: e.state, ...(e.tx ? { tx: e.tx } : {}), ...(e.nonce != null ? { nonce: e.nonce } : {}) };
    if (e.phase) phase = e.phase;
    if (e.state === "failed") failure = { step: e.step, why: e.detail };
  }
  return { steps, phase, failure };
}

/** Which compensations to run: the forward steps that reached `verified`, newest first, not yet compensated. */
export function compensationPlan(def, state) {
  return def
    .filter((s) => state.steps[s.name]?.state === "verified" && s.compensate && state.steps[s.compensate]?.state !== "verified")
    .reverse()
    .map((s) => s.compensate);
}
