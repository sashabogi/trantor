// Sidebar ACTIVE-NOW activity for a project, resolved from the same two truths AppShell's
// comment above its activity effect documents — OPEN (a live session process on this machine,
// or a herdr-visible pane wherever it actually runs) and BUSY (a hub heartbeat inside the 90s
// work window). Pulled out as a pure function (#6163) so the case that broke — a freshly-woken
// orch pane herdr already names an agent for, but that has no hub heartbeat yet because hooks
// fire on tool calls and it hasn't run one — is testable without mounting AppShell or mocking
// the Tauri bridge.
import type { LocalSession } from "../shared/api/client";
import type { Peer } from "../shared/api/client";
import { hubActivity } from "../features/workspace/seatActivity";
import { stateOf } from "../shared/presence";

export type ProjectActivity =
  | { kind: "busy"; lastSeen?: number; model?: string }
  | { kind: "open"; status: string | null };

/** Only "working" reads as mid-turn; idle, blocked, done and unknown are all "here, not moving". */
export function isWorkingStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "working";
}

/** #6094 — only "blocked" reads as the operator being asked for something (an approval or an
 *  AskUserQuestion the pane is sitting on): the one status among idle/blocked/done/unknown that
 *  is not just "here, not moving" but "here, and waiting on you". Case/whitespace-tolerant like
 *  `isWorkingStatus`, so the same raw string serves both checks. */
export function needsYou(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "blocked";
}

/** project → activity, merging local_sessions (OPEN, may already carry a herdr status) with the
 * freshest hub peer per session (BUSY, mid-turn right now). BUSY overrides OPEN for the same
 * project except when the OPEN row is already fresher — mirrors the prior inline logic exactly,
 * just made testable. */
export function computeProjectActivity(open: LocalSession[], peers: Peer[]): Map<string, ProjectActivity> {
  const m = new Map<string, ProjectActivity>();
  for (const o of open) m.set(o.project, { kind: "open", status: o.status });

  const best = new Map<string, Peer>();
  for (const p of peers) {
    const cur = best.get(p.session);
    if (!cur || (p.lastSeen ?? 0) > (cur.lastSeen ?? 0)) best.set(p.session, p);
  }
  for (const p of best.values()) {
    if (!p.project) continue;
    // #5965 — a runner-driven seat heartbeats only between turns, so heartbeat recency alone
    // reads it idle mid-turn; its hub status (`working · <trigger>`) is the source of truth then.
    const hubWorking = hubActivity(p.status) === "working" && p.online !== false;
    if (stateOf(p) !== "busy" && !hubWorking) continue;
    const cur = m.get(p.project);
    if (cur?.kind === "busy" && (cur.lastSeen ?? 0) >= (p.lastSeen ?? 0)) continue;
    m.set(p.project, { kind: "busy", lastSeen: p.lastSeen, model: p.model || p.llm });
  }
  return m;
}

/** ACTIVE NOW sort rank: a project mid-turn right now — busy via the hub, or open via herdr's own
 * "working" status before any heartbeat exists — sorts first; everything else (including a plain
 * open-idle row) sorts after. */
export function activityRank(act: ProjectActivity | undefined): 0 | 1 {
  if (!act) return 1;
  if (act.kind === "busy") return 0;
  if (act.kind === "open" && isWorkingStatus(act.status)) return 0;
  return 1;
}
