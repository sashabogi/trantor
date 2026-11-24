// Pure aggregation behind the Usage screen: ranges, vendors, daily series, agent/project rows (#13991).
import type { Card, Economics, Learning, LearningAgent, LearningModel, Peer } from "../../../shared/api/client";
import { dictGet } from "../../../shared/dict";

export type RangeKey = "today" | "7d" | "14d" | "30d" | "month" | "all";
export const RANGES: readonly { value: RangeKey; label: string }[] = [
  { value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "14d", label: "14 days" },
  { value: "30d", label: "30 days" }, { value: "month", label: "This month" }, { value: "all", label: "All time" },
];

const DAY_MS = 86_400_000;
const MAX_BAR_DAYS = 120;
/** The hub buckets telemetry by UTC calendar day, so every range here is UTC days too. */
export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (day: string, by: number): string => dayKey(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS);

export type RangeWindow = { start: string | null; end: string };

export function rangeWindow(range: RangeKey, now: number): RangeWindow {
  const end = dayKey(now);
  if (range === "today") return { start: end, end };
  if (range === "month") return { start: `${end.slice(0, 7)}-01`, end };
  if (range === "all") return { start: null, end };
  const back = range === "7d" ? 6 : range === "14d" ? 13 : 29;
  return { start: shiftDay(end, -back), end };
}

export const inWindow = (day: string, w: RangeWindow): boolean => (w.start === null || day >= w.start) && day <= w.end;

/** The days a bar chart draws, oldest first; All time starts at the first day any data exists. */
export function barDays(w: RangeWindow, earliest: string | null): string[] {
  const start = w.start ?? earliest ?? w.end;
  const out: string[] = [];
  for (let d = start; d <= w.end && out.length < 400; d = shiftDay(d, 1)) out.push(d);
  return out.slice(-MAX_BAR_DAYS);
}

export const VENDORS = ["Claude", "Codex", "GLM", "Kimi", "DeepSeek", "Qwen", "Other"] as const;
export type Vendor = (typeof VENDORS)[number];

const VENDOR_RULES: [RegExp, Vendor][] = [
  [/orchestrator|claude|opus|sonnet|haiku|fable|anthropic/i, "Claude"], [/codex|openai|gpt/i, "Codex"],
  [/glm|zai|zhipu/i, "GLM"], [/kimi|moonshot/i, "Kimi"], [/deepseek/i, "DeepSeek"], [/qwen/i, "Qwen"],
];
export function vendorOf(name: string): Vendor {
  for (const [re, v] of VENDOR_RULES) if (re.test(name)) return v;
  return "Other";
}

type DayStat = { day: string; turns: number; failures: number };
// SAFETY: /learning serves a per-day series the frozen client types omit; read through this widened shape.
export type SeriesAgent = LearningAgent & { series?: { failRate?: DayStat[] } };
export type SeriesModel = LearningModel & { series?: { saved?: { day: string; saved: number }[] } };

export type Scope = { agents: SeriesAgent[]; models: SeriesModel[] };
export function scopeFor(l: Learning, project: string | null): Scope {
  const agents = project ? dictGet(l.agentsByProject, project) ?? [] : l.agents;
  const models = project ? dictGet(l.modelsByProject, project) ?? [] : l.models;
  // SAFETY: narrowing the frozen types to their widened subtype; the extra fields are optional.
  return { agents: agents as SeriesAgent[], models: models as SeriesModel[] };
}

export type AgentStat = { agent: string; vendor: Vendor; models: string[]; turns: number; failures: number; points: DayStat[] };
export function agentStats(agents: SeriesAgent[], w: RangeWindow): AgentStat[] {
  return agents.map(a => {
    const points = (a.series?.failRate ?? []).filter(p => inWindow(p.day, w));
    const turns = points.reduce((s, p) => s + p.turns, 0);
    const failures = points.reduce((s, p) => s + p.failures, 0);
    return { agent: a.agent, vendor: vendorOf(a.agent), models: a.models, turns, failures, points };
  }).filter(a => a.turns > 0).sort((a, b) => b.turns - a.turns);
}

export type Filters = { project: string | null; vendor: Vendor | null; agent: string | null };
export const NO_FILTERS: Filters = { project: null, vendor: null, agent: null };
export const filterAgents = (stats: AgentStat[], f: Filters): AgentStat[] =>
  stats.filter(a => (!f.vendor || a.vendor === f.vendor) && (!f.agent || a.agent === f.agent));

export type DailyBar = { day: string; byVendor: Record<Vendor, number>; total: number };
const emptyVendors = () => ({ Claude: 0, Codex: 0, GLM: 0, Kimi: 0, DeepSeek: 0, Qwen: 0, Other: 0 }) satisfies Record<Vendor, number>;

function bars(days: string[]): Map<string, DailyBar> {
  return new Map(days.map(day => [day, { day, byVendor: emptyVendors(), total: 0 }]));
}
function bump(b: DailyBar | undefined, v: Vendor, n: number) {
  if (!b) return;
  b.byVendor[v] += n;
  b.total += n;
}

export function dailyTurns(stats: AgentStat[], days: string[]): DailyBar[] {
  const m = bars(days);
  for (const a of stats) for (const p of a.points) bump(m.get(p.day), a.vendor, p.turns);
  return [...m.values()];
}
export function dailyFailures(stats: AgentStat[], days: string[]): DailyBar[] {
  const m = bars(days);
  for (const a of stats) for (const p of a.points) bump(m.get(p.day), a.vendor, p.failures);
  return [...m.values()];
}
export function dailySaved(models: SeriesModel[], days: string[], vendor: Vendor | null): DailyBar[] {
  const m = bars(days);
  for (const mod of models) {
    const v = vendorOf(mod.model);
    if (vendor && v !== vendor) continue;
    for (const p of mod.series?.saved ?? []) bump(m.get(p.day), v, p.saved);
  }
  return [...m.values()];
}

/** The earliest day any agent has a turn on, for the All time axis. */
export function earliestDay(agents: SeriesAgent[]): string | null {
  let first: string | null = null;
  for (const a of agents) for (const p of a.series?.failRate ?? []) if (first === null || p.day < first) first = p.day;
  return first;
}

export type ProjectRow = { project: string; turns: number; failures: number; notional: number | null };
export function projectRows(l: Learning, e: Economics | null, w: RangeWindow, f: Filters): ProjectRow[] {
  return l.lessons.projects.map(project => {
    const stats = filterAgents(agentStats(scopeFor(l, project).agents, w), f);
    return {
      project, turns: stats.reduce((s, a) => s + a.turns, 0), failures: stats.reduce((s, a) => s + a.failures, 0),
      notional: dictGet(e?.notionalByProject ?? {}, project) ?? null,
    };
  }).filter(r => r.turns > 0 || (r.notional ?? 0) > 0).sort((a, b) => b.turns - a.turns);
}

export type EconPick = { available: boolean; label: string; cost: number; saved: number; tokens: number; apiValue: number | null };
const ECON_KEY = { today: "24h", "7d": "week", "30d": "month", all: "lifetime" } as const satisfies Partial<Record<RangeKey, string>>;
const ECON_LABEL = { "24h": "last 24 hours", week: "last 7 days", month: "last 30 days", lifetime: "all time" } as const satisfies Record<string, string>;

/** The hub serves rolling windows only, so 14 days and This month have no honest economics. */
export function econFor(range: RangeKey, e: Economics | null): EconPick {
  const none: EconPick = { available: false, label: "", cost: 0, saved: 0, tokens: 0, apiValue: null };
  const key = dictGet(ECON_KEY, range);
  const win = key && e?.windows ? dictGet(e.windows, key) : undefined;
  if (!key || !win) return none;
  const kinds = dictGet(e?.costKinds ?? {}, key) ?? {};
  const notional = Object.entries(kinds).filter(([k, v]) => k.includes("notional") && v.usd != null);
  return {
    available: true, label: dictGet(ECON_LABEL, key) ?? key, cost: win.cost_usd, saved: win.saved_usd,
    tokens: win.tokens_in + win.tokens_out,
    apiValue: notional.length ? notional.reduce((s, [, v]) => s + (v.usd ?? 0), 0) : null,
  };
}

export type CardRow = { id: number; title: string; status: string; seat: string; model: string; cost: number };
const touched = (t: Card): number => t.updated ?? t.ts ?? t.created ?? 0;

/** Cards that carry a cost and were touched inside the window; the hub stamps card times in ms. */
export function cardRows(tasks: Card[], w: RangeWindow, f: Filters): CardRow[] {
  return tasks
    .filter(t => t.costUsd != null && (!f.project || t.project === f.project))
    .filter(t => inWindow(dayKey(touched(t)), w))
    .filter(t => !f.vendor || vendorOf(`${t.workedBy ?? t.assignee ?? ""} ${t.model ?? ""}`) === f.vendor)
    .map(t => ({ id: t.id, title: t.title, status: t.status, seat: t.workedBy ?? t.assignee ?? "", model: t.model ?? "", cost: t.costUsd ?? 0 }))
    .sort((a, b) => b.cost - a.cost);
}

export type AgentRow = AgentStat & { machines: string[]; cardsDone: number };
export function agentRows(stats: AgentStat[], tasks: Card[], peers: Peer[], w: RangeWindow): AgentRow[] {
  return stats.map(a => {
    const machines = [...new Set(peers.filter(p => p.machine && vendorOf(`${p.llm ?? ""} ${p.session}`) === a.vendor).map(p => p.machine ?? ""))];
    const cardsDone = tasks.filter(t => t.status === "done" && inWindow(dayKey(touched(t)), w)
      && vendorOf(t.workedBy ?? t.assignee ?? "") === a.vendor).length;
    return { ...a, machines, cardsDone };
  });
}
