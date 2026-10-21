import { lstatSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { keyPath, listKeyNames, keysDir } from "./identity.mjs";

import { isTestIdentity } from "./test-identity-names.mjs";
export { isTestIdentity } from "./test-identity-names.mjs";

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

// An interrupted atomic key write strands `<name>.json.<pid>.<rand>.tmp` — and a tmp from a lost
// race holds a full PRIVATE key. Real keys always end in `.json`, so anything ending in `.tmp` in
// the keys tree is by construction an incomplete write; an hour past its mtime no live writer is
// still between write and rename, so it is safe to remove (--apply only, like the rest of prune).
export function pruneStaleTmp({ maxAgeMs = 3_600_000, apply = false, now = Date.now() } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("tmp age must be a positive number");
  const cutoff = now - maxAgeMs;
  const removed = [], kept = [];
  for (const dir of [keysDir(), join(keysDir(), "instances")]) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.name.endsWith(".tmp")) continue;              // a real key file never matches
      const file = join(dir, entry.name);
      let stat;
      try { stat = lstatSync(file); } catch { continue; }      // vanished mid-sweep
      if (!stat.isFile() || stat.isSymbolicLink()) continue;   // never follow a link out of the keys tree
      if (stat.mtimeMs >= cutoff) { kept.push(file); continue; }
      if (apply) {
        try { unlinkSync(file); } catch { kept.push(file); continue; }
      }
      removed.push(file);
    }
  }
  return { dryRun: !apply, maxAgeMs, removed, kept };
}
