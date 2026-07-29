// trantor — make a seat self-enrol on an authenticated hub.
//
// The gap this closes: crew seats are created on demand (`codex:crebral-health`, `glm:crebral`, …),
// so on a hub running RELAY_AUTH=enforce their brand-new keypair is an unknown identity and every
// call 401s. Hooks and runners FAIL OPEN by design, so the seat does not crash — it goes quiet, and
// the board simply stops recording it. Silent, and easy to mistake for "the crew didn't start".
//
// Pre-enrolling every brand x project by hand is a band-aid: it is O(providers x projects) and any
// new provider re-opens the hole. Instead the seat enrols itself at startup, using the OPERATOR's
// owner key — which is legitimate because a crew only ever runs on the operator's own machine, and
// that key is already sitting in ~/.agent-bus/keys. The owner mints a single-use, project-scoped
// invite and the seat immediately spends it, so the seat never holds owner rights.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { load, loadOrCreate } from "./identity.mjs";
import { sfetch } from "./signed-fetch.mjs";

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");

// Which local identity is allowed to mint invites. Configurable because the operator's identity name
// is a human choice, not something we can derive.
export function ownerIdentity() {
  const explicit = process.env.RELAY_OWNER_IDENTITY;
  if (explicit) return load(explicit);
  try {
    const cfg = JSON.parse(readFileSync(join(busDir(), "config.json"), "utf8"));
    if (cfg.ownerIdentity) return load(cfg.ownerIdentity);
  } catch {}
  return null;
}

// Returns { ok, reason }. NEVER throws and never blocks a turn — a hub that is down, or an operator
// key that is absent, must degrade to "unenrolled" rather than take the seat with it.
export async function ensureEnrolled(hubUrl, identity, project, { timeoutMs = 4000 } = {}) {
  if (!hubUrl || !identity?.pubkey) return { ok: false, reason: "no-identity" };
  try {
    // Cheapest possible probe that the hub authorises: if we are already known this is a no-op.
    const probe = await sfetch(`${hubUrl}/peer?session=${encodeURIComponent(identity.name)}`,
      { signal: AbortSignal.timeout(timeoutMs) }, identity);
    if (probe.status !== 401) return { ok: true, reason: "already-enrolled" };
  } catch { return { ok: false, reason: "hub-unreachable" }; }

  const owner = ownerIdentity();
  if (!owner?.privkey) return { ok: false, reason: "no-owner-key" };

  try {
    const inv = await sfetch(`${hubUrl}/invite`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: [{ project, role: "write" }], ttlSec: 300 }),
      signal: AbortSignal.timeout(timeoutMs),
    }, owner);
    if (!inv.ok) return { ok: false, reason: `invite-${inv.status}` };
    const { token } = await inv.json();

    const en = await sfetch(`${hubUrl}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: identity.name, kind: identity.kind || "agent", token }),
      signal: AbortSignal.timeout(timeoutMs),
    }, identity);
    return en.ok ? { ok: true, reason: "enrolled" } : { ok: false, reason: `enroll-${en.status}` };
  } catch (e) { return { ok: false, reason: "error:" + String(e?.message || e).slice(0, 40) }; }
}

export { loadOrCreate };
