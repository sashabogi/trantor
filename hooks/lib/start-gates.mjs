// SessionStart gates that decide what a fresh machine is told (#14322): pure helpers so tests can inject config.
import { loopbackHub } from "../../lib/identity.mjs";

export const HUB_DOWN_LINE = "The local Trantor hub is not running. Start it with `trantor hub`, or open the Trantor app, which starts it.";

export function loopbackUrl(u) {
  try { const s = String(u); return loopbackHub(s.endsWith("/") ? s : s + "/"); } catch { return false; }
}

// An unpinned project only matters when pins exist (another hub may hold the crew) or the fallback hub
// is not this machine. One local loopback hub with no pins is the normal setup: say nothing.
export function shouldWarnUnpinned(via, url, pinned) {
  if (via !== "global" && via !== "default") return false;
  return pinned.length > 0 || !loopbackUrl(url);
}

// The build doctrine is opt-in: config "buildDoctrine": true.
export function wantsBuildDoctrine(cfg) { return cfg?.buildDoctrine === true; }
