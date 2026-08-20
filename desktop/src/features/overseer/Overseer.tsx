// OVERSEER — the watcher's own view: what it is monitoring and proof it is operating.
//
// The overseer is deliberately NOT an agent: a mechanical 30s tick in the hub (lib/overseer.mjs,
// pure detection over live sessions + file claims + policy links), with the duty seat as its
// agentic half and a cheap model narrating warns after the fact. This view is that split made
// visible — a status strip that distinguishes QUIET from DEAD (the hub reports its own last tick),
// the live watch map (/overseer/status: links, autonomy levels, current detections), and the event
// history of what it actually did. Fleet altitude: everything here is cross-project by definition.
import { useEffect, useState } from "react";
import type { HubClient, HubEvent, OverseerStatus } from "../../shared/api/client";
import { ProposalsSection } from "../../shared/Proposals";
import { usePeers, stateOf } from "../../shared/presence";
import { rollUp, lasting } from "../../shared/rollup";
import { dictGet } from "../../shared/dict";

// Autonomy levels are 1-4 by contract, but a level read off the hub isn't a closed type
// client-side, so this stays an open lookup (`dictGet`, string-keyed) rather than a literal-keyed
// Record indexed directly.
const LEVEL_LABEL = { "1": "observe", "2": "warn", "3": "gate", "4": "auto" } as const satisfies Record<string, string>;

function agoS(ts: number) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function Overseer({ client }: { client: HubClient }) {
  const [status, setStatus] = useState<OverseerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HubEvent[]>([]);
  const { peers } = usePeers(client);

  useEffect(() => {
    let alive = true;
    const pull = () => client.overseerStatus()
      .then(s => { if (alive) { setStatus(s); setError(null); } })
      .catch(e => { if (alive) setError(String(e?.message || e)); });
    pull();
    const t = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    // Fetch DEEP (not 30) so the roll-up's counts are true — the whole point is to show that one
    // condition accounts for hundreds of rows rather than pretending each is news.
    const load = () => Promise.all([
      client.events({ type: "overseer.", limit: 300 }).then(r => r.events).catch((): HubEvent[] => []),
      client.events({ type: "verify.gate.", limit: 30 }).then(r => r.events).catch((): HubEvent[] => []),
    ]).then(([warns, gates]) => {
      if (!cancelled) setHistory([...warns, ...gates].sort((a, b) => b.ts - a.ts));
    });
    load();
    return client.streamEvents(ev => {
      if (ev.type?.startsWith("overseer.") || ev.type?.startsWith("verify.gate.")) load();
    });
  }, [client]);

  if (error && !status) return <div className="p-10 text-sm text-[var(--color-tr-fail)]">Overseer unavailable: {error}</div>;
  if (!status) return <div className="p-10 text-sm text-[var(--color-tr-muted)]">Reading the watcher…</div>;

  // Alive = the tick ran within two periods. The whole point of this strip: an empty warnings list
  // only means "clear" when the watcher can prove it is still looking.
  const alive = status.engine && status.lastTickTs > 0 && Date.now() - status.lastTickTs < status.tickMs * 2 + 5000;
  const rolled = rollUp(history);
  const projectsWithLevel = Object.entries(status.autonomy).filter(([k]) => k !== "*").sort();
  const liveByProject = new Map<string, number>();
  for (const p of peers ?? []) {
    if (p.project && stateOf(p) !== "offline") liveByProject.set(p.project, (liveByProject.get(p.project) ?? 0) + 1);
  }

  const Stat = ({ label, value, sub, dot }: { label: string; value: React.ReactNode; sub: React.ReactNode; dot?: React.ReactNode }) => (
    <div className="tr-card flex flex-col gap-1 p-5">
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-tr-muted)]">{dot}{label}</div>
      <div className="text-[20px] font-semibold">{value}</div>
      <div className="text-[12px] text-[var(--color-tr-muted)]">{sub}</div>
    </div>
  );

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Overseer</h1>
        <p className="tr-page-sub">Mechanical collision watch over the fleet — the duty agent mediates, a cheap model narrates.</p>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-8">

        <div className="mb-8 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          <Stat
            dot={<span className={`tr-dot ${alive ? "tr-dot-pulse" : ""}`}
                       style={{ background: alive ? "var(--color-tr-ok)" : "var(--color-tr-fail)" }} />}
            label="Watcher"
            value={alive ? "operating" : status.engine ? "stalled" : "engine missing"}
            sub={<>ticked {agoS(status.lastTickTs)} · every {Math.round(status.tickMs / 1000)}s</>}
          />
          <Stat label="Watching" value={status.watching.sessions}
                sub={<>live session(s) across {status.watching.projects} project(s)</>} />
          <Stat label="In flight" value={status.watching.claims}
                sub="file claim(s) being edited right now" />
          <Stat label="Escalation" value={status.dutySession ? "duty seat" : "human only"}
                sub={status.dutySession
                  ? <span className="tr-mono">{status.dutySession}</span>
                  : "no RELAY_DUTY_SESSION on this hub"} />
        </div>

        <div className="mb-8 empty:mb-0 empty:hidden"><ProposalsSection client={client} /></div>

        <section className="mb-8">
          <h2 className="tr-sec-title">Seeing now</h2>
          <p className="tr-sec-sub">The last tick's live detections, before dedup — what the watcher currently has eyes on.</p>
          <div className="mt-3 flex flex-col gap-2">
            {status.warnings.map((w, i) => (
              <div key={i} className="tr-card flex items-start gap-3 p-3.5">
                <span className="tr-dot shrink-0"
                      style={{ background: w.kind === "file-conflict" ? "var(--color-tr-fail)" : "var(--color-tr-warn)", marginTop: 6 }} />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-[13px] leading-snug">{w.detail}</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                    <span className="tr-chip shrink-0">{w.project}</span>
                    <span className="tr-chip shrink-0">{w.kind}</span>
                    {w.since ? <span className="text-[11px] text-[var(--color-tr-muted)]">{lasting(w.since)}</span> : null}
                    {w.sessions.map(s => <span key={s} className="tr-chip tr-mono shrink-0">{s}</span>)}
                    {w.files.slice(0, 3).map(f => <span key={f} className="tr-chip tr-mono shrink-0">{f}</span>)}
                  </div>
                </div>
              </div>
            ))}
            {!status.warnings.length && (
              <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
                {alive
                  ? <>Clear — {status.watching.sessions} session(s) watched, nothing colliding.</>
                  : <>No detections — but the watcher is not ticking, so this proves nothing.</>}
              </div>
            )}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Watch map</h2>
          <p className="tr-sec-sub">Declared codependencies and each project's autonomy level (1 observe · 2 warn · 3 gate · 4 auto — set in Settings).</p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4">
            <div className="flex flex-col gap-2">
              {status.links.map((l, i) => (
                <div key={i} className="tr-card p-3.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    {l.projects.map((p, j) => (
                      <span key={p} className="flex items-center gap-1.5">
                        {j > 0 && <span className="text-[var(--color-tr-muted)]">↔</span>}
                        <span className="tr-chip">{p}</span>
                        {(liveByProject.get(p) ?? 0) > 0 &&
                          <span className="tr-dot" style={{ background: "var(--color-tr-doing)", width: 6, height: 6 }} />}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[12px] text-[var(--color-tr-muted)]">{l.reason || "linked"}</div>
                </div>
              ))}
              {!status.links.length && (
                <div className="tr-card-ghost p-5 text-[13px]">
                  No links declared. <code className="text-[11px] opacity-70">trantor policy link &lt;a&gt; &lt;b&gt; --reason "…"</code>
                </div>
              )}
            </div>
            <div className="tr-card p-3.5">
              {projectsWithLevel.length ? (
                <div className="flex flex-col gap-1">
                  {projectsWithLevel.map(([proj, lvl]) => (
                    <div key={proj} className="flex items-center gap-2 py-0.5 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{proj}</span>
                      {(liveByProject.get(proj) ?? 0) > 0 &&
                        <span className="tr-dot" style={{ background: "var(--color-tr-doing)", width: 6, height: 6 }} />}
                      <span className={`tr-chip shrink-0 ${lvl >= 3 ? "text-[var(--color-tr-warn)]" : ""}`}>{lvl} {dictGet(LEVEL_LABEL, String(lvl)) ?? ""}</span>
                    </div>
                  ))}
                  <div className="mt-1 border-t border-white/[0.06] pt-1.5 text-[12px] text-[var(--color-tr-muted)]">
                    everything else: {status.autonomy["*"] ?? 1} {dictGet(LEVEL_LABEL, String(status.autonomy["*"] ?? 1))}
                  </div>
                </div>
              ) : (
                <div className="text-[13px] text-[var(--color-tr-muted)]">
                  Whole fleet at level {status.autonomy["*"] ?? 1} ({dictGet(LEVEL_LABEL, String(status.autonomy["*"] ?? 1))}).
                </div>
              )}
            </div>
          </div>
        </section>

        <section>
          <h2 className="tr-sec-title">What it did</h2>
          <p className="tr-sec-sub">
            Warnings issued and gates opened, one row per distinct condition — narrated where the cheap model has caught up.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {rolled.slice(0, 20).map(({ rep: e, count, first, last }, i) => {
              const gate = e.type === "verify.gate.opened";
              const when = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
              return (
                <div key={e.id ?? i} className="tr-card flex items-start gap-3 p-3.5">
                  <span className="tr-dot shrink-0"
                        style={{ background: gate ? "var(--color-tr-fail)" : "var(--color-tr-warn)", marginTop: 6 }} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-[13px] leading-snug">
                      {gate ? `gate opened — ${e.claim ?? ""}` : (e.narration ?? e.detail ?? "")}
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                      {e.project && <span className="tr-chip shrink-0">{e.project}</span>}
                      <span className="tr-chip shrink-0">{gate ? "verify gate" : (e.kind ?? "warn")}</span>
                      {count > 1 && <span className="tr-chip shrink-0 text-[var(--color-tr-warn)]">×{count}</span>}
                      <span className="text-[11px] text-[var(--color-tr-muted)]">
                        {count > 1 ? <>{when(first)} → {when(last)}</> : when(last)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {!rolled.length && (
              <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
                No interventions on record for this hub.
              </div>
            )}
            {history.length > 0 && (
              <p className="px-1 pt-1 text-[11px] text-[var(--color-tr-muted)]">
                {rolled.length} distinct condition(s) across {history.length} logged event(s).
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
