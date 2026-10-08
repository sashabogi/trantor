import { asString, asRecord } from "../../lib/decode.mjs";
import { readFileSync, writeFileSync, renameSync, symlinkSync, readlinkSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handoffDir } from "../../lib/project.mjs";
import { readFirstPaths, pathsReadIn } from "./handoff.mjs";

export const CLAIM_TTL_SECONDS = 600;

export function claimHandoff(record, session, now, transcriptBytes = 0, token = "") {
  if (record.consumed || !session?.session_id) return null;
  if (record.claim && record.claim.expiresAt > now) return null;
  const claim = { ...session, at: now, expiresAt: now + CLAIM_TTL_SECONDS, transcriptBytes, token };
  return { ...record, consumed: false, claim,
    states: [...(record.states || []), { state: "claimed", ts: now, by: session.session_id }] };
}

export function recapHandoff(record, { sessionId, token, replied, missed }, now) {
  if (record.consumed || record.claim?.session_id !== sessionId || record.claim?.token !== token) return null;
  if (!replied || missed.length) return null;
  return { ...record, consumed: true, consumedAt: now, consumedBy: record.claim,
    states: [...(record.states || []), { state: "recapped", ts: now, by: sessionId }] };
}

export function hasAssistantReply(body, claimedAt) {
  return body.split("\n").some(line => {
    let row;
    try { row = asRecord(JSON.parse(line)); } catch { return false; }
    if (row?.type !== "assistant" || row.isSidechain) return false;
    const timestamp = asString(row.timestamp);
    if (timestamp && Date.parse(timestamp) < claimedAt * 1000) return false;
    const content = asRecord(row.message)?.content;
    const text = asString(content);
    if (text !== null) return text.trim().length > 0;
    return Array.isArray(content) && content.some(block => {
      const b = asRecord(block);
      return b?.type === "text" && !!asString(b.text)?.trim();
    });
  });
}

// Serialize claim and recap writes; a killed hook's PID lock can be reclaimed (#11223).
function updateRecord(path, update) {
  const lock = `${path}.lock`;
  try { symlinkSync(String(process.pid), lock); }
  catch {
    try {
      const owner = readlinkSync(lock);
      try { process.kill(Number(owner), 0); return null; }
      catch (error) { if (error.code !== "ESRCH") return null; }
      if (readlinkSync(lock) !== owner) return null;
      unlinkSync(lock);
      symlinkSync(String(process.pid), lock);
    } catch { return null; }
  }
  try {
    const next = update(JSON.parse(readFileSync(path, "utf8")));
    if (!next) return null;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return next;
  } finally { unlinkSync(lock); }
}

export function claimHandoffFile(path, session, now = Math.floor(Date.now() / 1000)) {
  let bytes = 0;
  try { bytes = statSync(session.transcript_path).size; } catch {}
  return updateRecord(path, record => claimHandoff(record, session, now, bytes, randomUUID()));
}

export function loadPendingHandoff(project, { claim = true, freshSession = null, dir = handoffDir(), now = Math.floor(Date.now() / 1000) } = {}) {
  const prefix = `${project}-`;
  let files;
  try {
    files = readdirSync(dir).filter(f => f.startsWith(prefix) && /^\d+\.json$/.test(f.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length, -5)) - Number(a.slice(prefix.length, -5)));
  } catch { return null; }
  for (const file of files) {
    try {
      const path = join(dir, file);
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.consumed) continue;
      if (record.claim?.expiresAt > now) return null;
      if (!claim) return record;
      const next = claimHandoffFile(path, freshSession, now);
      if (!next) return null;
      const readFirst = readFirstPaths(next.summary || "");
      writeFileSync(recapStampPath(dir, freshSession.session_id), JSON.stringify({
        handoffId: next.id, file, token: next.claim.token, ts: now,
        mode: next.mode === "unattended" ? "unattended" : "attended", readFirst,
      }));
      return next;
    } catch { return null; }
  }
  return null;
}

export function recapStampPath(dir, sid) {
  return join(dir, `recap-pending-${String(sid).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

export function completeHandoffRecap({ sessionId, transcriptPath, dir = handoffDir(), now = Math.floor(Date.now() / 1000) }) {
  const stampPath = recapStampPath(dir, sessionId);
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    const file = stamp.file || `${stamp.handoffId}.json`;
    if (file.includes("/") || file.includes("\\")) return null;
    let missed = [];
    const next = updateRecord(join(dir, file), record => {
      if (record.claim?.session_id !== sessionId || record.claim?.token !== stamp.token) return null;
      if (record.claim.transcript_path !== transcriptPath) return null;
      const body = readFileSync(transcriptPath).subarray(record.claim.transcriptBytes).toString("utf8");
      missed = pathsReadIn(transcriptPath, stamp.readFirst || []).missed;
      return recapHandoff(record, { sessionId, token: stamp.token, missed,
        replied: hasAssistantReply(body, record.claim.at) }, now);
    });
    if (next) unlinkSync(stampPath);
    return { recapped: !!next, missed };
  } catch { return null; }
}
