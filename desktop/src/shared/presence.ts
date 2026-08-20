// Presence, defined ONCE. Every surface that says "live" must mean the same thing: the hub's
// heartbeat fires on PostToolUse, so a FRESH lastSeen means "actively calling tools", a stale-but-
// recent one means idle-at-the-prompt, and past the hub's online window the session is gone. The
// Agents view had this locally; the board needs it too (a DOING card is only believably in motion
// when its assignee is actually alive), and two copies of "what counts as live" is how the app and
// the board would drift apart.
import { useEffect, useState } from "react";
import type { HubClient, Peer } from "./api/client";

export const ONLINE_MS = 5 * 60 * 1000;   // matches the hub's RELAY_ONLINE_MS default
export const BUSY_MS = 90 * 1000;         // heartbeat is ~60s, so fresher than this means mid-turn

export type PresenceState = "busy" | "idle" | "offline";

export function stateOf(p: Peer): PresenceState {
  const age = Date.now() - (p.lastSeen ?? 0);
  if (age > ONLINE_MS) return "offline";
  return age < BUSY_MS ? "busy" : "idle";
}

export const PRESENCE_COLOR = {
  busy: "var(--color-tr-doing)",
  idle: "var(--color-tr-muted)",
  offline: "var(--color-tr-edge)",
} as const satisfies Record<PresenceState, string>;

export function ago(ts?: number) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export type PeersResult = { peers: Peer[] | null; error: string | null };

/** Poll + presence-stream refresh, shared by every view that shows liveness. Presence decays on a
 * timer, so poll rather than relying purely on events — a peer going quiet produces no event until
 * the hub's sweep notices. */
export function usePeers(client: HubClient): PeersResult {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => client.peers()
      .then(p => { if (alive) { setPeers(p); setError(null); } })
      .catch(e => { if (alive) setError(String(e?.message || e)); });
    load();
    const t = setInterval(load, 15000);
    const off = client.streamEvents(ev => { if (ev.type?.startsWith("presence")) load(); });
    return () => { alive = false; clearInterval(t); off?.(); };
  }, [client]);
  return { peers, error };
}

/** session → presence, for O(1) lookups from card assignees. */
export function presenceMap(peers: Peer[] | null): Map<string, PresenceState> {
  const m = new Map<string, PresenceState>();
  for (const p of peers ?? []) m.set(p.session, stateOf(p));
  return m;
}
