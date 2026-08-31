// Duty liveness — the pure half of Home's dead-duty strip (#5688 folded into the Usage card).
// The hub publishes the duty seat's heartbeat on /health (one truth for the app and doctor):
//   duty: { configured, online, lastSeenMs, darkSinceMs, queuedEscalations }
// This module decides what that means: whether the strip shows at all, and whether a poll is
// the EDGE of a dark episode (the only moment a human gets a notification — one per episode,
// never per poll). The component half lives in DutyStrip.tsx.
import { invoke } from "@tauri-apps/api/core";

export type DutyHealth = {
  configured: boolean;
  online: boolean;
  lastSeenMs: number;
  darkSinceMs: number;
  queuedEscalations: number;
};

// /health is a PUBLIC hub endpoint (no signature needed), but the webview cannot fetch
// cleartext HTTP on macOS (ATS) — every hub read rides the Rust hub_request bridge, exactly
// like HubClient does. Null = hub unreachable or shape changed; the strip stays silent.
export async function fetchDutyHealth(base: string): Promise<DutyHealth | null> {
  try {
    const res = await invoke<{ status: number; body: string }>("hub_request", {
      base, method: "GET", path: "/health", body: null,
    });
    if (res.status !== 200) return null;
    // SAFETY: body comes from our own hub's /health, and duty is optional-chained with a null
    // fallback — a malformed payload degrades to "no reading", never a crash.
    const h = JSON.parse(res.body) as { duty?: DutyHealth };
    return h?.duty ?? null;
  } catch {
    return null;
  }
}

// The strip exists only when there is something to say: a seat is configured and it is dark.
// "Not configured" is honest silence — there is no watcher to mourn, and no red banner that
// says an optional seat is missing.
export function dutyIsDark(d: DutyHealth | null): boolean {
  return !!d && d.configured && !d.online;
}

// The notification edge: true ONLY on a dark transition the app actually watched. A first
// read that is already dark predates the window — the strip says so, but it must not
// interrupt: nobody needs a siren for news that is hours old. One true per episode, because
// the next poll's prev is dark too.
export function dutyDarkEdge(prev: DutyHealth | null, next: DutyHealth | null): boolean {
  return dutyIsDark(next) && !!prev && !dutyIsDark(prev);
}

// "dark for 12m" / "dark for 2h 05m" — duration, not a date (the countdown rule the rest of
// the app already follows).
export function darkDuration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// "14m ago" — mirrors the drill-in's freshness vocabulary.
export function lastSeenAgo(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
