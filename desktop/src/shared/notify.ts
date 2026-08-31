// Native notifications — the HUMAN half of the wake ladder.
//
// The agent half (T1 mid-turn, T2 at end-of-turn) already works via hooks. This is the other half:
// the operator is not staring at the board, and something happened that genuinely needs them. That
// was the whole point of the intersession arc — Sasha had to be the message bus because nothing
// could reach him either.
//
// Deliberately NARROW. A notification for every event is a notification for nothing, and the fastest
// way to have someone disable them permanently. Only things that actually want a human:
//   • a DIRECT message addressed to this operator (a broadcast is FYI — it does not interrupt)
//   • a verify gate opening (work is blocked pending a decision — that IS the go/no-go moment)
//   • a crew seat failing (a stalled crew burns quota silently)
// Card moves, presence and handoffs are deliberately excluded: high volume, low urgency.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { HubEvent } from "./api/client";

let ready: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (ready !== null) return ready;
  try {
    ready = await isPermissionGranted();
    if (!ready) ready = (await requestPermission()) === "granted";
  } catch { ready = false; }
  return ready;
}

/** Returns a notification for an event, or null when it does not warrant interrupting a human. */
export function notificationFor(ev: HubEvent, me: string, isOffline?: (session: string) => boolean): { title: string; body: string } | null {
  if (ev.type === "message") {
    // toSession is the addressee; "all" is a broadcast and must never raise a notification.
    const to = ev.toSession ?? "";
    if (!to || to === "all") return null;
    if (to === me) return { title: `Message from ${ev.by ?? "an agent"}`, body: (ev.text ?? "").slice(0, 240) };
    // The safe T3 of the wake ladder: an agent messaged a session that is OFFLINE. T1/T2 reach a
    // session that is running or stopping; nothing can safely reach one that is truly idle — except
    // the human. So the stuck message becomes YOUR notification: you are the only one who can wake it.
    if (to.includes(":") && isOffline?.(to)) {
      return {
        title: `${ev.by ?? "an agent"} → ${to} (idle)`,
        body: `That session is offline and will only see this on its next turn: "${(ev.text ?? "").slice(0, 160)}"`,
      };
    }
    return null;
  }
  if (ev.type === "verify.gate.opened") {
    return { title: "Verify gate opened", body: `${ev.project ?? ""} — ${ev.reason ?? "a decision is needed"}`.trim() };
  }
  // Same class as a verify gate: an agent filed a bounded permission ask and is working around the
  // gap until the human rules. Filing is a transition (once per proposal), so this can't spam.
  if (ev.type === "proposal.filed") {
    return {
      title: `${ev.by ?? "an agent"} proposes a permission`,
      body: `${ev.project ? `[${ev.project}] ` : ""}${(ev.scope ?? "").slice(0, 200)} — approve or deny on Home`,
    };
  }
  if (ev.type === "presence.offline" && String(ev.by ?? "").includes(":")) {
    const brand = String(ev.by).split(":")[0];
    // Only crew brands, not the operator's own sessions going quiet.
    if (["codex", "kimi", "glm", "deepseek", "openrouter"].includes(brand)) {
      return { title: `${brand} went offline`, body: `${ev.project ?? ""} — a seat stopped reporting` };
    }
  }
  return null;
}

// The duty whitelist — a STATE edge, not a hub event (home/DutyStrip.tsx watches /health and
// calls this only on the healthy→dark transition it observed, once per episode). A dead duty
// seat is the same class as a failed crew seat: the fleet's watcher is gone and nothing else
// will say so. First-read-dark stays silent (the strip says it; a notification for hours-old
// news is noise).
export async function notifyDutyDark(d: { lastSeenMs: number; queuedEscalations?: number }): Promise<boolean> {
  if (!notificationsEnabled()) return false;
  if (!(await ensurePermission())) return false;
  const ago = d.lastSeenMs < 60_000 ? "under a minute"
    : d.lastSeenMs < 3_600_000 ? `${Math.floor(d.lastSeenMs / 60_000)}m`
    : `${Math.floor(d.lastSeenMs / 3_600_000)}h`;
  try {
    sendNotification({
      title: "Duty seat dark — nobody is watching the bus",
      body: `Duty last reported ${ago} ago${d.queuedEscalations ? ` · ${d.queuedEscalations} escalation${d.queuedEscalations === 1 ? "" : "s"} queued` : ""}. Bring it back: trantor duty up.`,
    });
    return true;
  } catch { return false; }
}

// The user's off-switch, persisted locally. Read at fire time so the Settings toggle takes
// effect immediately — no restart, no plumbing.
export function notificationsEnabled(): boolean {
  try { return localStorage.getItem("tr.notifications") !== "off"; } catch { return true; }
}
export function setNotificationsEnabled(on: boolean) {
  try { localStorage.setItem("tr.notifications", on ? "on" : "off"); } catch {}
}

export async function notifyIfWorthIt(ev: HubEvent, me: string, isOffline?: (session: string) => boolean) {
  if (!notificationsEnabled()) return false;
  const n = notificationFor(ev, me, isOffline);
  if (!n) return false;
  if (!(await ensurePermission())) return false;
  try { sendNotification(n); return true; } catch { return false; }
}
