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
export function notificationFor(ev: HubEvent, me: string): { title: string; body: string } | null {
  const any = ev as Record<string, unknown>;
  if (ev.type === "message") {
    // toSession is the addressee; "all" is a broadcast and must never raise a notification.
    const to = String(any.toSession ?? "");
    if (!to || to === "all" || to !== me) return null;
    return { title: `Message from ${ev.by ?? "an agent"}`, body: String(any.text ?? "").slice(0, 240) };
  }
  if (ev.type === "verify.gate.opened") {
    return { title: "Verify gate opened", body: `${ev.project ?? ""} — ${String(any.reason ?? "a decision is needed")}`.trim() };
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

export async function notifyIfWorthIt(ev: HubEvent, me: string) {
  const n = notificationFor(ev, me);
  if (!n) return false;
  if (!(await ensurePermission())) return false;
  try { sendNotification(n); return true; } catch { return false; }
}
