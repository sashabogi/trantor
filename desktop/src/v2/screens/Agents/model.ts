// Pure roster logic for the Agents screen: presence, vendor, sort, filters, current card (#13992).
import type { BalanceEntry, BalancesReport, Card, Peer } from "../../../shared/api/client";
import { chipFrom, type BalanceChip } from "../../../features/fleet/balanceChips";
import { BUSY_MS, ONLINE_MS } from "../../../shared/presence";
import type { Presence } from "../../ui/identity";

export type SeatView = { peer: Peer; presence: Presence; vendor: string; project: string };
export type StateFilter = "all" | "working" | "needs-you" | "idle";
export type Scope = "project" | "all";

/** Presence from lastSeen (the PostToolUse heartbeat) plus the hub's open asks to the human. */
export function presenceOf(p: Peer, needsYou: ReadonlySet<string>, now = Date.now()): Presence {
  const age = now - (p.lastSeen ?? 0);
  if (age > ONLINE_MS) return "offline";
  if (needsYou.has(p.session)) return "needs-you";
  return age < BUSY_MS ? "working" : "ready";
}

const VENDORS: [RegExp, string][] = [
  [/claude|anthropic|opus|sonnet|haiku/, "Claude"],
  [/codex|openai|gpt/, "Codex"],
  [/glm|zai|zhipu/, "GLM"],
  [/kimi|moonshot/, "Kimi"],
  [/deepseek/, "DeepSeek"],
  [/qwen/, "Qwen"],
];

/** The vendor a seat runs on, by its llm field, else its session id ("codex:trantor"). */
export function vendorOf(p: Peer): string {
  const key = `${p.llm ?? ""} ${p.session.split(":")[0]}`.toLowerCase();
  for (const [re, label] of VENDORS) if (re.test(key)) return label;
  return p.llm || "agent";
}

export function toSeatViews(peers: Peer[], needsYou: ReadonlySet<string>, now = Date.now()): SeatView[] {
  return peers.filter(p => p.kind !== "tool").map(peer => ({
    peer, presence: presenceOf(peer, needsYou, now), vendor: vendorOf(peer),
    project: peer.project || (peer.session.includes(":") ? peer.session.split(":").slice(1).join(":") : ""),
  }));
}

const ORDER = { "needs-you": 0, working: 1, ready: 2, offline: 3 } as const satisfies Record<Presence, number>;

/** Needs you first, then working, then ready; most recently seen first inside a state. */
export function rosterSort(views: SeatView[]): SeatView[] {
  return [...views].sort((a, b) => ORDER[a.presence] - ORDER[b.presence] || (b.peer.lastSeen ?? 0) - (a.peer.lastSeen ?? 0));
}

export function applyFilters(views: SeatView[], scope: Scope, project: string, state: StateFilter): SeatView[] {
  return views.filter(v => {
    if (scope === "project" && v.project !== project) return false;
    if (state === "working") return v.presence === "working";
    if (state === "needs-you") return v.presence === "needs-you";
    if (state === "idle") return v.presence === "ready";
    return true;
  });
}

export type HeaderCounts = { live: number; working: number; needsYou: number; offline: number; offlineNames: string[] };

export function headerCounts(views: SeatView[]): HeaderCounts {
  const off = views.filter(v => v.presence === "offline");
  return {
    live: views.length - off.length,
    working: views.filter(v => v.presence === "working").length,
    needsYou: views.filter(v => v.presence === "needs-you").length,
    offline: off.length,
    offlineNames: off.slice(0, 3).map(v => v.peer.session),
  };
}

/** The card a seat is on now: its newest doing/testing card, by assignee or by who actually moved it. */
export function currentCard(session: string, cards: Card[]): Card | null {
  const mine = cards.filter(c => (c.assignee === session || c.workedBy === session) && (c.status === "doing" || c.status === "testing"));
  mine.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return mine[0] ?? null;
}

export function sessionsNeedingYou(proposals: { session: string }[], holds: { session: string; other: string }[]): Set<string> {
  const s = new Set<string>();
  for (const p of proposals) s.add(p.session);
  for (const h of holds) { s.add(h.session); s.add(h.other); }
  return s;
}

/** Autonomy level for a project: its own, else the fleet default, else 2 (the hub default). */
export function levelFor(autonomy: Record<string, number>, project: string): number {
  return autonomy[project] ?? autonomy["*"] ?? 2;
}

export type PlanState = { tone: "ok" | "warn" | "bad" | "none"; line: string };

/** The balances row for a vendor, matched by the same canonical label the fleet chips use. */
export function entryForVendor(vendor: string, report: BalancesReport | null): BalanceEntry | undefined {
  return report?.entries.find(e => chipFrom(e, { snapshotTs: report.ts })?.label === vendor);
}

export function chipForVendor(vendor: string, report: BalancesReport | null): BalanceChip | null {
  const entry = entryForVendor(vendor, report);
  return entry && report ? chipFrom(entry, { snapshotTs: report.ts }) : null;
}

/** One plain line per vendor plan for the Add-a-seat picker, from the same balances rows. */
export function planLine(entry: BalanceEntry | undefined): PlanState {
  if (!entry) return { tone: "none", line: "no reading" };
  if (!entry.ok) return { tone: "bad", line: "unreachable" };
  if (entry.remainingPct != null) {
    const used = Math.round(100 - entry.remainingPct);
    return entry.low ? { tone: "warn", line: `${used}% · wait` } : { tone: "ok", line: `${used}% · room` };
  }
  if (entry.kind === "prepaid") return { tone: entry.low ? "warn" : "ok", line: "metered" };
  return { tone: "none", line: "no meter" };
}

/** The seat a crew notice is about: useCrew writes "<seat> · <what happened>". */
export function noticeSeat(text: string): string {
  const i = text.indexOf(" · ");
  return i < 0 ? "" : text.slice(0, i);
}
