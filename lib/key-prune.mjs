import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { keyPath, listKeyNames } from "./identity.mjs";

// Exact fixture families with numeric run IDs; a generic test/demo substring is not enough.
const TEST_NAME = /^(?:[A-Za-z0-9.-]+[_:])?(?:relay-selftest|hoff-selftest|consumedby|tt-h5|pctest|trantor-handoff|trantor-supersede|trantor-defer|cap-e2e|injcap|manual-skill)-\d+(?:[_:.-][\w:.-]+)?$/;
export const isTestIdentity = name => TEST_NAME.test(name);

export function pruneTestKeys({ snapshots, idleDays = 7, apply = false, now = Date.now() }) {
  if (!Number.isFinite(idleDays) || idleDays <= 0) throw new Error("--idle-days must be a positive number");
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.some(s => s?.complete !== true || !Array.isArray(s.identities))) {
    throw new Error("hub usage is unavailable or incomplete; no keys pruned");
  }
  const usage = new Map();
  for (const snapshot of snapshots) {
    for (const row of snapshot.identities) {
      if (!/^[a-f0-9]{64}$/i.test(row.pubkey) || !Number.isFinite(row.lastSeen) || row.lastSeen < 0 || ![true, false].includes(row.live)) {
        throw new Error("invalid hub usage; no keys pruned");
      }
      const prev = usage.get(row.pubkey);
      usage.set(row.pubkey, { lastSeen: Math.max(prev?.lastSeen || 0, row.lastSeen), live: !!prev?.live || row.live });
    }
  }
  const cutoff = now - idleDays * 86400000;
  const removed = [], kept = [];
  for (const fileBase of listKeyNames()) {
    const file = keyPath(fileBase);
    let stat, raw, id;
    try { stat = lstatSync(file); raw = readFileSync(file, "utf8"); id = JSON.parse(raw); }
    catch { kept.push({ name: fileBase, reason: "unreadable" }); continue; }
    const name = id?.name || fileBase;
    const seen = usage.get(id?.pubkey);
    const reason = !stat.isFile() || stat.isSymbolicLink() ? "not a regular file"
      : !isTestIdentity(name) || keyPath(name) !== file ? "not a known test identity"
      : !/^[a-f0-9]{64}$/i.test(id?.pubkey || "") ? "invalid public key"
      : !id.privkey || id.keychain ? "keychain stub"
      : stat.mtimeMs >= cutoff ? "recent file"
      : seen?.live ? "live peer"
      : seen && seen.lastSeen >= cutoff ? "recent hub activity" : "";
    if (reason) { kept.push({ name, reason }); continue; }
    if (apply) {
      const current = lstatSync(file);
      if (current.isSymbolicLink() || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || readFileSync(file, "utf8") !== raw) {
        kept.push({ name, reason: "changed during prune" }); continue;
      }
      unlinkSync(file);
    }
    removed.push(name);
  }
  return { dryRun: !apply, idleDays, removed, kept };
}
