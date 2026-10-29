#!/usr/bin/env node
// trantor pair — mint a phone-pairing invite and print it as a trantor://enroll link.
// Same owner signing as `trantor invite`, but scoped for the companion app: every project,
// the approver role, single use, ten minutes. The phone scans the QR (desktop Settings) or
// opens the link (this command, --sim) and enrolls itself.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const USAGE = "usage: trantor pair [--role owner] [--sim] [--tailnet] [--json]";
if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
const asJson = args.includes("--json");
const openSim = args.includes("--sim");
const forceTailnet = args.includes("--tailnet");
const roleIdx = args.indexOf("--role");
const role = roleIdx >= 0 ? (args[roleIdx + 1] || "") : "approver";
if (!role || role.startsWith("--")) {
  console.error(USAGE);
  process.exit(1);
}

const { resolveOwnerIdentity, phoneHubAddress, signRequest } = await import(join(ROOT, "lib/identity.mjs"));
const { resolveHubInfo } = await import(join(ROOT, "lib/project.mjs"));

const hub = resolveHubInfo().url.replace(/\/+$/, "");
let id, used;
try {
  const response = await fetch(`${hub}/health`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`hub health returned HTTP ${response.status}`);
  const health = await response.json();
  used = phoneHubAddress(hub, String(health.publicUrl || ""), forceTailnet);
  id = await resolveOwnerIdentity(hub);
} catch (error) {
  const message = `Pairing failed: ${error.message}. Hub: ${hub}`;
  if (asJson) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(1);
}

const payload = { scopes: [{ project: "*", role }], ttlSec: 600, kind: "human" };
const body = JSON.stringify(payload);
const sig = signRequest(id, { method: "POST", path: "/invite", body });
let r;
try {
  r = await fetch(`${hub}/invite`, { method: "POST", headers: { "content-type": "application/json", ...sig }, body });
} catch (e) {
  console.error(`error: hub unreachable at ${hub} — ${e.message}`);
  process.exit(1);
}
const j = await r.json().catch(() => ({}));

// The hub may predate the approver role (#12113): an explicit 400 names it, an older hub is
// quieter — cleanScope folds unknown roles down to read and echoes the folded scope. Either
// way a link minted here would pair the phone into near-nothing, so refuse it instead.
const echoed = Array.isArray(j.scopes) ? j.scopes[0]?.role : undefined;
const roleRefused = !r.ok
  ? /role|approver/i.test(String(j.error || "")) || r.status === 400
  : echoed !== role;
if (roleRefused) {
  const why = r.ok
    ? `this hub does not know the "${role}" role yet — it answered with "${echoed}", which would pair the phone near-read-only`
    : `hub refused the invite: ${j.error || r.statusText}`;
  if (asJson) console.log(JSON.stringify({ error: why, hint: "retry with --role owner" }));
  else console.error(`Pairing refused: ${why}\nRetry with --role owner.`);
  process.exit(1);
}
if (!r.ok) {
  if (asJson) console.log(JSON.stringify({ error: j.error || r.statusText }));
  else console.error(`Pairing failed: ${j.error || r.statusText}`);
  process.exit(1);
}

const link = `trantor://enroll?hub=${encodeURIComponent(used.hub)}&token=${j.token}`;
const expiresAt = Number(j.expiresAt) || Date.now() + 600000;
const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));

if (asJson) {
  console.log(JSON.stringify({ link, token: j.token, hub: used.hub, hubPublic: used.public, expiresAt }));
} else {
  const where = used.public ? "public — the phone needs no Tailscale" : "tailnet — the phone needs Tailscale";
  console.log(`Pair link (single use):\n${link}\nHub in the link: ${used.hub} (${where}).\nExpires in ${mins} minute${mins === 1 ? "" : "s"}.`);
}

if (openSim) {
  if (process.platform !== "darwin") {
    console.error("--sim needs macOS (xcrun simctl)");
    process.exit(1);
  }
  const sim = spawnSync("xcrun", ["simctl", "openurl", "booted", link], { stdio: "pipe" });
  if (sim.status !== 0) {
    console.error(`simctl could not open the link: ${String(sim.stderr).trim() || "no booted simulator?"}`);
    process.exit(1);
  }
  if (!asJson) console.log("Opened in the booted simulator.");
}
