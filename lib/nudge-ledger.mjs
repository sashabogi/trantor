// #11355: ONE shared nudged-id ledger for BOTH orchestrator-wake nudgers — the mechanical
// com.trantor.wake-nudge daemon and the duty seat's runner-side nudge plan. Each path checks and
// stamps BEFORE sending; of two nudgers offered the same unread id exactly one send lands, the
// other logs "already nudged #N". Per-recipient file, atomic check-and-stamp under a lock.
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { busDir } from "./project.mjs";

// While an id is nudged under this window it is suppressed; past it the stamp is pruned and a
// still-unread id is nudgeable again.
export const NUDGE_LEDGER_TTL_MS = 10 * 60 * 1000;

export function nudgeLedgerPath(recipient, { bus = busDir() } = {}) {
  const safe = String(recipient || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(bus, `nudged-${safe}.json`);
}

function readLedger(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!(parsed?.nudged instanceof Object) || Array.isArray(parsed.nudged)) throw new Error("bad shape");
    return parsed;
  } catch {
    return { version: 1, nudged: {} };
  }
}

function writeLedger(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function withLedgerLock(path, update) {
  const lockPath = `${path}.lock`;
  let lock = null;
  for (let attempt = 0; attempt < 100 && lock === null; attempt++) {
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  if (lock === null) throw new Error(`could not lock ${path}`);
  try {
    const state = readLedger(path);
    await update(state);
    writeLedger(path, state);
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch {}
  }
}

// Check-and-stamp BEFORE sending: ids stamped under the TTL come back skipped (the caller logs
// "already nudged #N"), the rest are stamped for `owner`. One locked step, so of two concurrent
// nudgers exactly one wins.
export async function reserveNudgeIds({
  recipient, ids, owner, now = Date.now(), ttlMs = NUDGE_LEDGER_TTL_MS, bus, ledgerPath, log = (m) => console.error(m),
} = {}) {
  const wanted = [...new Set((ids || []).map(id => String(id ?? "").trim()).filter(Boolean))];
  if (!recipient || !wanted.length) return { allowed: [], skipped: [] };
  // ledgerPath is resolved LAZILY from `bus`: a default parameter would bind busDir() at call
  // time and silently ignore the caller's bus override.
  const path = ledgerPath || nudgeLedgerPath(recipient, { bus });
  const allowed = [], skipped = [];
  await withLedgerLock(path, state => {
    for (const id of wanted) {
      const at = Number(state.nudged[id]?.at || 0);
      if (at > 0 && now - at < ttlMs) skipped.push({ id, reason: `already nudged #${id}` });
      else {
        state.nudged[id] = { at: now, by: String(owner || "") };
        allowed.push(id);
      }
    }
    for (const [id, v] of Object.entries(state.nudged)) {
      if (now - Number(v?.at || 0) >= ttlMs) delete state.nudged[id];
    }
  });
  for (const s of skipped) log(s.reason);
  return { allowed, skipped };
}

// Drop stamps for ids whose send ended UNVERIFIED — the ledger mirrors the duty-claim lifecycle
// (auditDutyNudges releases unverified claims), so a failed or unconfirmed send never suppresses
// the other nudger. With `owner`, only that path's own stamps are dropped.
export async function releaseNudgeIds({ recipient, ids, owner, bus, ledgerPath, now = Date.now(), ttlMs = NUDGE_LEDGER_TTL_MS } = {}) {
  const wanted = [...new Set((ids || []).map(id => String(id ?? "").trim()).filter(Boolean))];
  if (!recipient || !wanted.length) return;
  const path = ledgerPath || nudgeLedgerPath(recipient, { bus });
  await withLedgerLock(path, state => {
    for (const id of wanted) {
      const at = Number(state.nudged[id]?.at || 0);
      const own = !owner || state.nudged[id]?.by === String(owner);
      if (at > 0 && now - at < ttlMs && own) delete state.nudged[id];
    }
  });
}
