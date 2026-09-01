import type { HubEvent, OverseerStatus, Peer } from "../../shared/api/client";
import { stateOf } from "../../shared/presence";

export const LEVEL_LABEL = {
  "1": "observe",
  "2": "warn",
  "3": "gate",
  "4": "auto",
} as const satisfies Record<string, string>;

export type Episode = {
  key: string;
  project: string;
  kind: string;
  detail: string;
  files: string[];
  sessions: string[];
  first: number;
  last: number;
  count: number;
  open: boolean;
};

function eventSessions(e: HubEvent): string[] {
  return Array.isArray(e.sessions) ? e.sessions.filter(Boolean) : [];
}

function episodeKey(project: string, kind: string, detail: string, files: string[], sessions: string[]) {
  return [project, kind, detail, [...files].sort().join(","), [...sessions].sort().join(",")].join("|");
}

export function episodeCards(status: OverseerStatus, events: HubEvent[]): Episode[] {
  const by = new Map<string, Episode>();
  const add = (row: {
    project?: string; kind?: string; detail?: string; files?: string[]; sessions?: string[];
    ts?: number; since?: number; open?: boolean;
  }) => {
    const project = row.project || "fleet";
    const kind = row.kind || "warn";
    const detail = row.detail || "";
    const files = row.files ?? [];
    const sessions = row.sessions ?? [];
    const key = episodeKey(project, kind, detail, files, sessions);
    const ts = row.ts ?? Date.now();
    const first = row.since || ts;
    const cur = by.get(key);
    if (!cur) {
      by.set(key, { key, project, kind, detail, files, sessions, first, last: ts, count: 1, open: !!row.open });
      return;
    }
    cur.first = Math.min(cur.first, first);
    cur.last = Math.max(cur.last, ts);
    cur.count += 1;
    cur.open ||= !!row.open;
  };

  for (const w of status.warnings) {
    add({ ...w, ts: status.lastTickTs, open: true });
  }
  for (const e of events.filter(e => e.type?.startsWith("overseer."))) {
    add({ project: e.project, kind: e.kind, detail: e.detail, files: e.files ?? [], sessions: eventSessions(e), ts: e.ts });
  }
  return [...by.values()].sort((a, b) => Number(b.open) - Number(a.open) || b.last - a.last);
}

export function quietEvidence(status: OverseerStatus, peers: Peer[] | null, now = Date.now()): string {
  if (!status.engine || !status.lastTickTs) return "watcher has not produced a sweep yet; quiet is unverified";
  const age = Math.max(0, now - status.lastTickTs);
  const seconds = Math.round(age / 1000);
  const live = peers?.filter(p => stateOf(p) !== "offline").length ?? status.watching.sessions;
  const total = peers?.length ?? status.watching.sessions;
  const seatText = total === live ? `all ${live} known seat${live === 1 ? "" : "s"} heartbeating` : `${live}/${total} known seats heartbeating`;
  return `presence swept ${seconds}s ago, ${seatText}, ${status.watching.claims} file claim${status.watching.claims === 1 ? "" : "s"} watched`;
}

export function dutyActions(events: HubEvent[], dutySession: string, limit = 5): HubEvent[] {
  return events
    .filter(e => e.by === "hub:duty" || e.by === dutySession || e.toSession === dutySession || /UNDELIVERED/.test(e.text ?? ""))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export function escalationLedger(events: HubEvent[]): HubEvent[] {
  return events
    .filter(e => /UNDELIVERED/.test(e.text ?? "") || /undelivered/i.test(e.detail ?? ""))
    .sort((a, b) => b.ts - a.ts);
}

export function policyProjects(status: OverseerStatus): string[] {
  const projects = new Set(Object.keys(status.autonomy).filter(p => p !== "*"));
  for (const l of status.links) for (const p of l.projects) projects.add(p);
  for (const w of status.warnings) if (w.project) projects.add(w.project);
  return [...projects].sort();
}

