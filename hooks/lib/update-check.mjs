// trantor update-check: a one-time desktop notification plus an in-session context block when a
// newer Trantor exists. Installed version comes from this hook's own plugin.json; "latest" from the
// npm dist-tags endpoint behind a 6h TTL cache (~/.agent-bus/update-check.json), 1.5s timeout,
// fallback to cache. The notification fires once per NEW version. Cheap, fail-silent.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));               // <version>/hooks/lib
const DATA = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
const STAMP = join(DATA, "update-check.json");
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/trantor/dist-tags";

export function readConfig() {
  try { const p = join(DATA, "config.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; }
  catch { return {}; }
}

function nowSec() { try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return Math.floor(Date.now() / 1000); } }
function readStamp() { try { return JSON.parse(readFileSync(STAMP, "utf8")); } catch { return {}; } }
function writeStamp(o) { try { if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true }); writeFileSync(STAMP, JSON.stringify(o, null, 2)); } catch {} }

// The version of the trantor plugin THIS hook is part of (…/hooks/lib → ../../.claude-plugin/plugin.json).
// Falls back to the package.json (covers running straight from the repo, where both sit at the root).
export function installedVersion() {
  for (const rel of ["../../.claude-plugin/plugin.json", "../../package.json"]) {
    try { const p = join(HERE, rel); if (existsSync(p)) { const v = JSON.parse(readFileSync(p, "utf8")).version; if (v) return v; } } catch {}
  }
  return "";
}

// Numeric a.b.c compare → -1 | 0 | 1. (Pre-release tags aren't used by trantor's release flow, so a
// plain numeric compare is correct and keeps this dependency-free.)
export function cmpSemver(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) < (pb[i] || 0)) return -1; if ((pa[i] || 0) > (pb[i] || 0)) return 1; }
  return 0;
}

// Latest published version, throttled by TTL. Returns the cached value on a fresh-enough check or on any
// network failure; refetches (and re-stamps) only when the cache is stale. Never throws.
export async function latestVersion(conf = readConfig()) {
  const ttlH = Number(process.env.TRANTOR_UPDATE_TTL_H || conf.updateCheckTtlHours || 6);
  const stamp = readStamp();
  if (stamp.latest && stamp.checkedAt && (nowSec() - stamp.checkedAt) < ttlH * 3600) return stamp.latest;
  try {
    const r = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    const latest = j?.latest || stamp.latest || "";
    writeStamp({ ...stamp, checkedAt: nowSec(), latest });
    return latest;
  } catch { return stamp.latest || ""; }
}

// { available, installed, latest } — `available` true only when installed < latest. Disabled by
// TRANTOR_NO_UPDATE_CHECK=1 or config.updateCheck:false.
export async function updateAvailable(conf = readConfig()) {
  if (process.env.TRANTOR_NO_UPDATE_CHECK === "1" || conf.updateCheck === false) return { available: false, installed: "", latest: "" };
  const installed = installedVersion();
  const latest = await latestVersion(conf);
  if (!installed || !latest) return { available: false, installed, latest };
  return { available: cmpSemver(installed, latest) < 0, installed, latest };
}

// Fire a native desktop notification — but only ONCE per new version (so multiple session starts don't
// each pop one). Returns true if it actually notified. Disabled by TRANTOR_NO_UPDATE_NOTIFY=1 or
// config.updateDesktopNotify:false. Best-effort; never throws.
export function maybeNotifyDesktop({ installed, latest } = {}, conf = readConfig()) {
  try {
    if (!latest) return false;
    if (process.env.TRANTOR_NO_UPDATE_NOTIFY === "1" || conf.updateDesktopNotify === false) return false;
    if (readStamp().notifiedVersion === latest) return false;     // already told them about THIS version
    const title = "Trantor update available";
    const msg = `${installed || "?"} → ${latest}. Update: claude plugin update trantor@trantor`;
    if (process.platform === "darwin") {
      let done = false;
      try { execSync("command -v terminal-notifier", { stdio: "ignore" });
        execSync(`terminal-notifier -title ${JSON.stringify(title)} -message ${JSON.stringify(msg)} -group trantor-update`, { timeout: 3000 });
        done = true;
      } catch {}
      if (!done) {
        const osa = `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`;
        execSync(`osascript -e ${JSON.stringify(osa)}`, { timeout: 3000 });
      }
    } else if (process.platform === "linux") {
      execSync(`notify-send ${JSON.stringify(title)} ${JSON.stringify(msg)}`, { timeout: 3000 });
    } else {
      return false;
    }
    writeStamp({ ...readStamp(), notifiedVersion: latest });
    return true;
  } catch { return false; }
}
