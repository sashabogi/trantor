// LEARNING — the self-learning loop, surfaced. What the agents learned while building (relay
// lessons), how reliable each seat actually is (turn telemetry), and what each cheap model cost
// and saved (Scrooge ledger + guardrails). GLOBAL view: a lesson learned on one project exists to
// be applied on the next, so scoping this to the active project by default would defeat it —
// the scope selector narrows on demand instead.
//
// TWO hubs feed this on purpose. Lessons are SHARED state and live on the project hub. Turn
// telemetry and the Scrooge ledger are files on THIS MACHINE (~/.agent-bus/logs, ~/.token-scrooge)
// — only the machine-local hub can read them, and they are this operator's economics, not the
// team's. So: merge the project hub's view with the local hub's, dedup lessons, union the rest.
import { useEffect, useMemo, useState } from "react";
import { HubClient } from "../../shared/api/client";
import type { Learning as LearningData, LessonRec } from "../../shared/api/client";

// The machine-local hub. Every install runs one (launchd/systemd); it is the only process that can
// see this machine's telemetry + ledger files.
const LOCAL_HUB = "http://127.0.0.1:4477";

function mergeLearning(a: LearningData | null, b: LearningData | null): LearningData | null {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set<string>();
  const dedup = (ls: LessonRec[]) => ls.filter(l => {
    const k = `${l.scope} ${l.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const unionBy = <T,>(xs: T[], ys: T[], key: (x: T) => string, better: (x: T, y: T) => T): T[] => {
    const m = new Map(xs.map(x => [key(x), x]));
    for (const y of ys) { const k = key(y); m.set(k, m.has(k) ? better(m.get(k)!, y) : y); }
    return [...m.values()];
  };
  const byAgent: LearningData["lessons"]["byAgent"] = {};
  for (const src of [a.lessons.byAgent, b.lessons.byAgent])
    for (const [k, v] of Object.entries(src)) (byAgent[k] ||= []).push(...v);
  const byProject: LearningData["lessons"]["byProject"] = {};
  for (const src of [a.lessons.byProject, b.lessons.byProject])
    for (const [k, v] of Object.entries(src)) (byProject[k] ||= []).push(...v);
  const agents = unionBy(a.agents, b.agents, x => x.agent, (x, y) => (x.turns >= y.turns ? x : y));
  const models = unionBy(a.models, b.models, x => x.model, (x, y) => (x.calls >= y.calls ? x : y));
  const agentsByProject: LearningData["agentsByProject"] = { ...b.agentsByProject, ...a.agentsByProject };
  const modelsByProject: LearningData["modelsByProject"] = { ...b.modelsByProject, ...a.modelsByProject };
  const global = dedup([...a.lessons.global, ...b.lessons.global]);
  const perAgent = Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, dedup(v)]));
  const totalLessons = global.length + Object.values(perAgent).reduce((s, v) => s + v.length, 0);
  return {
    totals: {
      lessons: totalLessons,
      guardrails: Math.max(a.totals.guardrails, b.totals.guardrails),
      turns: Math.max(a.totals.turns, b.totals.turns),
      failures: Math.max(a.totals.failures, b.totals.failures),
      failRate: (a.totals.turns >= b.totals.turns ? a : b).totals.failRate,
      models: models.length,
    },
    lessons: {
      global, byAgent: perAgent, byProject,
      projects: [...new Set([...a.lessons.projects, ...b.lessons.projects])].sort(),
    },
    agents, agentsByProject, models, modelsByProject,
  };
}

const ALL = "all projects";

function LessonRow({ l }: { l: LessonRec }) {
  return (
    <div className="flex gap-3 border-l-2 border-[var(--color-tr-ok)] py-1.5 pl-3 text-sm">
      <span className="tr-mono w-20 shrink-0 text-[11px] leading-5 text-[var(--color-tr-muted)]">
        {l.ts ? new Date(l.ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "—"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-[13px]">{l.text}</div>
        <div className="mt-0.5 text-[11px] text-[var(--color-tr-muted)]">
          {l.scope !== "global" && <span className="mr-2 rounded bg-black/30 px-1.5 py-0.5">{l.scope}</span>}
          {l.by || "—"}
        </div>
      </div>
    </div>
  );
}

export function Learning({ client }: { client: HubClient }) {
  const [data, setData] = useState<LearningData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState(ALL);

  useEffect(() => {
    let alive = true;
    setData(null); setError(null); setScope(ALL);
    const local = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost")
      ? null
      : new HubClient(LOCAL_HUB);
    Promise.all([
      client.learning().catch(() => null),
      local ? local.learning().catch(() => null) : Promise.resolve(null),
    ]).then(([remote, loc]) => {
      if (!alive) return;
      const merged = mergeLearning(remote, loc);
      if (merged) setData(merged);
      else setError("no hub reachable");
    });
    return () => { alive = false; };
  }, [client]);

  const agents = useMemo(
    () => (!data ? [] : scope === ALL ? data.agents : data.agentsByProject[scope] ?? []),
    [data, scope],
  );
  const models = useMemo(
    () => (!data ? [] : (scope === ALL ? data.models : data.modelsByProject[scope] ?? []).filter(m => m.calls > 0 || m.guardrailCount > 0)),
    [data, scope],
  );
  const lessons = useMemo(() => {
    if (!data) return [];
    if (scope !== ALL) return data.lessons.byProject[scope] ?? [];
    const perAgent = Object.values(data.lessons.byAgent).flat();
    return [...data.lessons.global, ...perAgent].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }, [data, scope]);

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Learning unavailable: {error}</div>;
  if (!data) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading…</div>;

  const t = data.totals;
  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="flex items-start justify-between px-10 pt-8 pb-5">
        <div>
          <h1 className="tr-page-title">Learning</h1>
          <p className="tr-page-sub">{t.lessons} lessons · {t.guardrails} guardrails · {t.turns.toLocaleString()} turns · {Math.round(t.failRate * 100)}% fail</p>
        </div>
        <select value={scope} onChange={e => setScope(e.target.value)} className="tr-input mt-1">
          <option value={ALL}>{ALL}</option>
          {data.lessons.projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </header>

      <div className="flex flex-1 gap-8 overflow-hidden px-10 pb-8">
        {/* what was learned */}
        <section className="flex min-w-0 flex-[3] flex-col">
          <div className="tr-label mb-2">
            lessons {scope !== ALL && `· ${scope}`}
          </div>
          <div className="flex-1 overflow-y-auto pr-2">
            {lessons.map((l, i) => <LessonRow key={i} l={l} />)}
            {!lessons.length && <div className="p-2 text-sm text-[var(--color-tr-muted)]">No lessons recorded here yet.</div>}
          </div>
        </section>

        {/* who is reliable, and what the cheap labor cost/saved */}
        <section className="flex min-w-0 flex-[2] flex-col gap-4 overflow-y-auto">
          <div>
            <div className="tr-label mb-2">seat reliability</div>
            {agents.map(a => (
              <div key={a.agent} className="flex items-baseline gap-2 border-b border-[var(--color-tr-edge)] py-1.5 text-sm">
                <span className="w-24 shrink-0 truncate">{a.agent}</span>
                <span className="text-[11px] text-[var(--color-tr-muted)]">{a.turns} turns</span>
                <span className="ml-auto text-[11px]"
                      style={{ color: a.failRate > 0.2 ? "var(--color-tr-fail)" : a.failRate > 0.05 ? "var(--color-tr-warn)" : "var(--color-tr-ok)" }}>
                  {Math.round(a.failRate * 100)}% fail
                </span>
              </div>
            ))}
            {!agents.length && <div className="text-sm text-[var(--color-tr-muted)]">No turn telemetry on this hub.</div>}
          </div>
          <div>
            <div className="tr-label mb-2">model economics</div>
            {models.map(m => (
              <div key={m.model} className="flex items-baseline gap-2 border-b border-[var(--color-tr-edge)] py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{m.model}</span>
                {m.guardrailCount > 0 && <span className="text-[11px] text-[var(--color-tr-muted)]">{m.guardrailCount} 🎓</span>}
                <span className="text-[11px] text-[var(--color-tr-muted)]">{m.calls} calls · ${m.cost_usd.toFixed(2)}</span>
                <span className="text-[11px] text-[var(--color-tr-ok)]">saved ${m.saved_usd.toFixed(0)}</span>
              </div>
            ))}
            {!models.length && <div className="text-sm text-[var(--color-tr-muted)]">No ledger on this hub.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
