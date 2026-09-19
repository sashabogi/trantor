// Sidebar ACTIVE-NOW activity for a project. #7775: BUSY used to mean "a hub heartbeat inside the
// 90s work window", so every project whose session had touched the hub recently read "mid-turn".
// The state now rests on the same liveness signals `trantor retire` decides with (livenessHold in
// lib/retire-panes.mjs), and reports UNKNOWN rather than guessing when nothing reports anything.
import type { LocalSession } from "../shared/api/client";
import type { Peer } from "../shared/api/client";
import { hubActivity } from "../features/workspace/seatActivity";
import { ago, ONLINE_MS } from "../shared/presence";

/** working = a turn is executing right now · needs-you = it stopped and is waiting on the operator ·
 *  idle = something is here and nothing is executing · unknown = present, but nothing reports what
 *  it is doing. `unknown` exists so the row can decline to answer instead of inventing a status. */
export type ActivityState = "working" | "needs-you" | "idle" | "unknown";

export type ProjectActivity = {
  state: ActivityState;
  /** The signal the state rests on, in the operator's words. The row's tooltip prints exactly this,
   *  so it can never assert something the data does not support. */
  evidence: string;
  /** Freshest heartbeat behind the row, when a hub peer supplied the signal. Never the signal itself. */
  lastSeen?: number;
  model?: string;
};

/** Only "working" reads as mid-turn; idle, blocked, done and unknown are all "here, not moving". */
export function isWorkingStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "working";
}

/** #6094 — "blocked" is the one status that is not just "here, not moving" but "here, and waiting on
 *  you". #7775 item 3: this is no longer asked of herdr alone. herdr's screen detection is blind to
 *  runner-driven seats and was not firing in practice, so the runner's own hub status — `blocked …`
 *  in its vocabulary, per `hubActivity` — answers the same question from the other side. */
export function needsYou(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "blocked" || hubActivity(s) === "blocked";
}

/** herdr's per-pane agent_status, mapped to the liveness question `livenessHold` asks of it: both
 *  "working" and "busy" mean a turn is running. A row with no status at all reports nothing. */
function herdrWorking(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "working" || s === "busy";
}

const EVIDENCE = {
  hubWorking: "the runner reports a turn executing here",
  herdrWorking: "herdr sees this pane working",
  hubBlocked: "the runner reports its turn blocked, waiting on you",
  herdrBlocked: "herdr sees this pane blocked, waiting on you",
  idle: "a session is here and nothing reports a turn executing",
  unknown: "a session process is here; nothing reports what it is doing",
} as const;

const RANK = { "needs-you": 0, working: 1, idle: 2, unknown: 3 } satisfies Record<ActivityState, number>;

/** A peer only carries evidence while the hub still considers it online. Past that window its last
 *  status is a memory, not a report, and a memory must not light a row up. */
function peerIsLive(p: Peer, now: number): boolean {
  return p.online !== false && now - (p.lastSeen ?? 0) <= ONLINE_MS;
}

/** project → activity. Local sessions (process truth + herdr's status) and hub peers (the runner's
 *  own status) are two views of the same question; the strongest signal across them wins, in the
 *  order `livenessHold` uses — a turn in flight, then blocked, then idle, then no evidence. */
export function computeProjectActivity(
  open: LocalSession[], peers: Peer[], now: number = Date.now(),
): Map<string, ProjectActivity> {
  const m = new Map<string, ProjectActivity>();
  const put = (project: string, next: ProjectActivity) => {
    const cur = m.get(project);
    if (cur && RANK[cur.state] <= RANK[next.state]) return;
    m.set(project, next);
  };

  for (const o of open) {
    if (!o.project) continue;
    if (herdrWorking(o.status)) put(o.project, { state: "working", evidence: EVIDENCE.herdrWorking });
    else if (needsYou(o.status)) put(o.project, { state: "needs-you", evidence: EVIDENCE.herdrBlocked });
    else if ((o.status ?? "").trim()) put(o.project, { state: "idle", evidence: EVIDENCE.idle });
    else put(o.project, { state: "unknown", evidence: EVIDENCE.unknown });
  }

  const best = new Map<string, Peer>();
  for (const p of peers) {
    const cur = best.get(p.session);
    if (!cur || (p.lastSeen ?? 0) > (cur.lastSeen ?? 0)) best.set(p.session, p);
  }
  for (const p of best.values()) {
    if (!p.project || !peerIsLive(p, now)) continue;
    const seen = { lastSeen: p.lastSeen, model: p.model || p.llm };
    const activity = hubActivity(p.status);
    if (activity === "working") put(p.project, { state: "working", evidence: EVIDENCE.hubWorking, ...seen });
    else if (activity === "blocked") put(p.project, { state: "needs-you", evidence: EVIDENCE.hubBlocked, ...seen });
    else if (activity === "idle") put(p.project, { state: "idle", evidence: EVIDENCE.idle, ...seen });
  }
  return m;
}

/** ACTIVE NOW sort rank. A project waiting on the operator sorts ABOVE one that is merely working:
 *  #7775 item 2 — the operator must see which project cannot move without them without clicking
 *  anything, and the top of the list is the only place that guarantees it. */
export function activityRank(act: ProjectActivity | undefined): number {
  return act ? RANK[act.state] : RANK.unknown;
}

/** Wake is a real action only where the evidence says no turn is running: an idle session takes the
 *  kickoff, a project with no session at all gets one opened. A working row would only answer with
 *  its pane id, and an unknown row cannot be promised either outcome — so neither offers the button.
 *  #7775 item 1, and the design system's no-fake-affordances rule. */
export function wakeIsReal(act: ProjectActivity | undefined): boolean {
  if (!act) return true;
  return act.state === "idle" || act.state === "needs-you";
}

export type ActivityLine = { text: string; tone: "warn" | "muted" };

/** The line under the project name. Each state says only what its evidence supports — "mid-turn"
 *  appears for `working` and nowhere else, and `unknown` says so in words rather than picking one. */
export function activityLine(act: ProjectActivity | undefined, now: number = Date.now()): ActivityLine | null {
  if (!act) return null;
  if (act.state === "needs-you") return { text: "needs you", tone: "warn" };
  if (act.state === "working") {
    const parts = ["mid-turn", act.lastSeen ? `${ago(act.lastSeen, now)} ago` : null, act.model || null];
    return { text: parts.filter(Boolean).join(" · "), tone: "muted" };
  }
  return { text: act.state === "idle" ? "idle" : "status unknown", tone: "muted" };
}

/** The row's tooltip: the evidence itself, never a claim on top of it. */
export function activityTitle(act: ProjectActivity | undefined): string | undefined {
  return act?.evidence;
}
