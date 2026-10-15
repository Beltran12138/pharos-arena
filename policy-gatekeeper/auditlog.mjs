// Append-only decision log. Each line carries the hash of the previous line, so editing or deleting any
// past decision breaks the chain and `verify` reports where.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const GENESIS = "0".repeat(64);
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function append(path, entry) {
  const log = readLog(path);
  const prev = log.at(-1);
  const body = { seq: (prev?.seq ?? 0) + 1, ...entry, prevHash: prev?.hash ?? GENESIS };
  const line = { ...body, hash: sha(JSON.stringify(body)) };
  appendFileSync(path, JSON.stringify(line) + "\n");
  return line;
}

export function verify(path) {
  let prevHash = GENESIS;
  for (const [i, line] of readLog(path).entries()) {
    const { hash, ...body } = line;
    if (body.prevHash !== prevHash) return { ok: false, at: i + 1, why: "prevHash does not match the line before" };
    if (sha(JSON.stringify(body)) !== hash) return { ok: false, at: i + 1, why: "line content does not match its hash" };
    prevHash = hash;
  }
  return { ok: true, lines: readLog(path).length };
}

/** Amount allowed per symbol on the UTC day of `at`, in the given mode (dry-run and live are separate). */
export function spentOn(path, at, mode) {
  const day = at.toISOString().slice(0, 10);
  const out = {};
  for (const l of readLog(path)) {
    if (l.decision !== "allow" || l.mode !== mode || l.at.slice(0, 10) !== day) continue;
    if (l.execution && l.execution.status !== "success" && l.execution.status !== "simulated") continue;
    for (const s of l.spends) out[s.symbol] = (out[s.symbol] ?? 0n) + BigInt(s.amount);
  }
  return out;
}
