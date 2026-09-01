// OVERSEER — the watcher's own view: what it is monitoring and proof it is operating.
//
// The duty seat must not be another terminal window the operator has to watch. This screen folds
// the whole surface into the app: duty liveness and controls, open episodes, stuck-mail ledger, and
// the policy map the hub uses to decide when to warn or gate.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ExternalLink, Link2, Minus, Plus, Power, ShieldCheck, Square, Unlink } from "lucide-react";
import {
  dutyLogPath,
  dutyStart,
  dutyStop,
  openCode,
  policyLink,
  policySet,
  policyUnlink,
  type DutyHealth,
  type Economics,
  type HubClient,
  type HubEvent,
  type OverseerStatus,
  type Peer,
} from "../../shared/api/client";
import { ProposalsSection } from "../../shared/Proposals";
import { usePeers, stateOf } from "../../shared/presence";
import { lasting } from "../../shared/rollup";
import { dictGet } from "../../shared/dict";
import { dutyActions, episodeCards, escalationLedger, LEVEL_LABEL, policyProjects, quietEvidence, type Episode } from "./model";

function agoS(ts: number) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function money(n: number | null | undefined) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 3 : 2)}` : "";
}

function eventText(e: HubEvent) {
  return e.text || e.narration || e.detail || e.claim || e.type;
}

function eventSessions(e: HubEvent) {
  return Array.isArray(e.sessions) ? e.sessions.filter(Boolean) : [];
}

function dutyCost(econ: Economics | null) {
  const byProject = econ?.notionalByProject ?? {};
  return byProject["trantor-duty"] ?? byProject["duty"] ?? null;
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub: ReactNode; tone?: "ok" | "warn" | "fail" }) {
  const color = tone === "ok" ? "var(--color-tr-ok)" : tone === "fail" ? "var(--color-tr-fail)" : tone === "warn" ? "var(--color-tr-warn)" : "var(--color-tr-muted)";
  return (
    <div className="tr-card flex min-w-0 flex-col gap-1 p-4" style={{ borderColor: tone ? color : undefined }}>
      <div className="text-[12px] text-[var(--color-tr-muted)]">{label}</div>
      <div className="min-w-0 truncate text-[18px] font-semibold" style={{ color }}>{value}</div>
      <div className="text-[12px] text-[var(--color-tr-muted)]">{sub}</div>
    </div>
  );
}

function DutyChip({ status, duty, peer, cost }: { status: OverseerStatus; duty: DutyHealth | null; peer?: Peer; cost: number | null }) {
  const online = duty?.configured ? duty.online : !!status.dutySession && !!peer && stateOf(peer) !== "offline";
  const model = peer?.model || peer?.llm || "";
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--color-tr-edge)] bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
      <ShieldCheck size={13} />
      <span style={{ color: online ? "var(--color-tr-ok)" : "var(--color-tr-fail)" }}>{online ? "duty online" : duty?.configured ? "duty dark" : "duty not wired"}</span>
      {model && <span className="tr-chip tr-mono">{model}</span>}
      {money(cost) && <span className="tr-chip">{money(cost)} today</span>}
      {duty?.queuedEscalations ? <span className="tr-chip text-[var(--color-tr-warn)]">{duty.queuedEscalations} queued</span> : null}
    </div>
  );
}

function EpisodeCard({ e }: { e: Episode }) {
  return (
    <div className="tr-card p-3.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13px] leading-snug">{e.detail || e.kind}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="tr-chip">{e.project}</span>
            <span className="tr-chip">{e.kind}</span>
            <span className="tr-chip text-[var(--color-tr-warn)]">warned once</span>
            <span className="text-[11px] text-[var(--color-tr-muted)]">{e.open ? lasting(e.first) : `resolved ${agoS(e.last)}`}</span>
          </div>
        </div>
        {e.count > 1 && <span className="tr-chip shrink-0">x{e.count}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {e.sessions.map(s => <span key={s} className="tr-chip tr-mono">{s}</span>)}
        {e.files.map(f => <span key={f} className="tr-chip tr-mono">{f}</span>)}
      </div>
    </div>
  );
}

export function Overseer({ client }: { client: HubClient }) {
  const [status, setStatus] = useState<OverseerStatus | null>(null);
  const [duty, setDuty] = useState<DutyHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HubEvent[]>([]);
  const [messages, setMessages] = useState<HubEvent[]>([]);
  const [econ, setEcon] = useState<Economics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkA, setLinkA] = useState("");
  const [linkB, setLinkB] = useState("");
  const [linkReason, setLinkReason] = useState("");
  const { peers } = usePeers(client);

  const refresh = () => Promise.allSettled([
    client.overseerStatus().then(s => { setStatus(s); setError(null); }),
    client.health().then(h => setDuty(h.duty ?? null)).catch(() => setDuty(null)),
    client.economics().then(setEcon).catch(() => setEcon(null)),
    client.events({ type: "overseer.", limit: 300 }).then(r => r.events).catch((): HubEvent[] => []),
    client.events({ type: "verify.gate.", limit: 60 }).then(r => r.events).catch((): HubEvent[] => []),
    client.events({ type: "message", limit: 500 }).then(r => r.events).catch((): HubEvent[] => []),
  ]).then(rows => {
    const [,,, overseer, gates, msg] = rows;
    const ov = overseer.status === "fulfilled" ? overseer.value : [];
    const gt = gates.status === "fulfilled" ? gates.value : [];
    const ms = msg.status === "fulfilled" ? msg.value : [];
    setHistory([...ov, ...gt].sort((a, b) => b.ts - a.ts));
    setMessages(ms.sort((a, b) => b.ts - a.ts));
  }).catch(e => setError(String(e?.message || e)));

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    const off = client.streamEvents(ev => {
      if (ev.type?.startsWith("overseer.") || ev.type?.startsWith("verify.gate.") || ev.type === "message" || ev.type?.startsWith("presence")) {
        void refresh();
      }
    });
    return () => { clearInterval(t); off(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const dutyPeer = useMemo(() => peers?.find(p => p.session === status?.dutySession), [peers, status?.dutySession]);
  const alive = !!status && status.engine && status.lastTickTs > 0 && Date.now() - status.lastTickTs < status.tickMs * 2 + 5000;
  const episodes = status ? episodeCards(status, history) : [];
  const escalations = escalationLedger(messages);
  const actions = status ? dutyActions(messages, status.dutySession) : [];
  const gates = history.filter(e => e.type === "verify.gate.opened");
  const projects = status ? policyProjects(status) : [];

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setNotice(null);
    try {
      const out = await action();
      setNotice(out || "done");
      await refresh();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDutyLog = () => void run("log", async () => {
    const path = await dutyLogPath();
    await openCode(path, "path");
    return "opened duty.log";
  });

  const sendGateVerdict = (gate: HubEvent, verdict: string) => void run(`gate-${gate.id ?? gate.ts}`, async () => {
    const sessions = eventSessions(gate);
    if (!sessions.length) throw new Error("gate event has no agent sessions to notify");
    await Promise.all(sessions.map(s => client.send(s, `Overseer gate verdict: ${verdict}. ${gate.claim || gate.detail || ""}`, gate.project)));
    return `verdict sent to ${sessions.length} session(s)`;
  });

  if (error && !status) return <div className="p-10 text-sm text-[var(--color-tr-fail)]">Overseer unavailable: {error}</div>;
  if (!status) return <div className="p-10 text-sm text-[var(--color-tr-muted)]">Reading the watcher...</div>;

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="flex flex-wrap items-start gap-3 px-10 pt-8 pb-5">
        <div className="min-w-0 flex-1">
          <h1 className="tr-page-title">Overseer</h1>
          <p className="tr-page-sub">Mechanical collision watch, duty triage, and policy in one app surface.</p>
        </div>
        <DutyChip status={status} duty={duty} peer={dutyPeer} cost={dutyCost(econ)} />
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-8">
        <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          <Stat label="Watcher" value={alive ? "operating" : status.engine ? "stalled" : "engine missing"}
                tone={alive ? "ok" : "fail"}
                sub={<>ticked {agoS(status.lastTickTs)} · every {Math.round(status.tickMs / 1000)}s</>} />
          <Stat label="Watching" value={status.watching.sessions}
                sub={<>live session(s) across {status.watching.projects} project(s)</>} />
          <Stat label="Open episodes" value={episodes.filter(e => e.open).length}
                tone={episodes.some(e => e.open) ? "warn" : undefined}
                sub={episodes.length ? `${episodes.length} distinct condition(s)` : quietEvidence(status, peers)} />
          <Stat label="Escalation ledger" value={duty?.queuedEscalations ?? escalations.length}
                tone={(duty?.queuedEscalations ?? escalations.length) ? "warn" : undefined}
                sub="queued now plus recent undelivered notices" />
        </div>

        {notice && <div className="mb-5 rounded-md border border-[var(--color-tr-edge)] bg-white/[0.03] px-3 py-2 text-[12px] text-[var(--color-tr-muted)]">{notice}</div>}
        <div className="mb-8 empty:mb-0 empty:hidden"><ProposalsSection client={client} /></div>

        <section className="mb-8">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="tr-sec-title">Duty seat</h2>
            <button type="button" disabled={!!busy} onClick={() => void run("duty-up", dutyStart)}
                    className="tr-chip hover:text-[var(--color-tr-ok)] disabled:opacity-40" title="Start trantor duty up">
              <Power size={12} /> Start
            </button>
            <button type="button" disabled={!!busy} onClick={() => void run("duty-down", dutyStop)}
                    className="tr-chip hover:text-[var(--color-tr-fail)] disabled:opacity-40" title="Stop trantor duty down">
              <Square size={11} /> Stop
            </button>
            <button type="button" disabled={!!busy} onClick={openDutyLog}
                    className="tr-chip hover:text-[var(--color-tr-text)] disabled:opacity-40" title="Open the duty log">
              <ExternalLink size={12} /> Log
            </button>
          </div>
          <p className="tr-sec-sub">
            {duty?.configured
              ? `${duty.online ? "Online" : "Dark"} · last seen ${duty.lastSeenMs ? `${Math.round(duty.lastSeenMs / 1000)}s ago` : "now"} · ${duty.queuedEscalations} queued escalation(s)`
              : "No duty seat is registered on this hub."}
          </p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
            {actions.map(e => (
              <div key={e.id ?? e.ts} className="tr-card p-3 text-[12px]">
                <div className="break-words leading-snug">{eventText(e)}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
                  <span>{agoS(e.ts)}</span>
                  {e.by && <span className="tr-chip tr-mono">{e.by}</span>}
                </div>
              </div>
            ))}
            {!actions.length && <div className="tr-card-ghost p-4 text-[13px]">No recent duty actions on this hub.</div>}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Episodes</h2>
          <p className="tr-sec-sub">One row per condition, with evidence and duration. Repeats accrue on the same episode.</p>
          <div className="mt-3 flex flex-col gap-2">
            {episodes.map(e => <EpisodeCard key={e.key} e={e} />)}
            {!episodes.length && (
              <div className="tr-card-ghost p-5 text-[13px]">
                Clear because {quietEvidence(status, peers)}.
              </div>
            )}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Escalation ledger</h2>
          <p className="tr-sec-sub">What the hub thinks is stuck, without opening the duty terminal.</p>
          <div className="mt-3 flex flex-col gap-2">
            {escalations.slice(0, 12).map(e => (
              <div key={e.id ?? e.ts} className="tr-card p-3.5">
                <div className="break-words text-[13px] leading-snug">{eventText(e)}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="tr-chip">{agoS(e.ts)}</span>
                  {e.project && <span className="tr-chip">{e.project}</span>}
                  {e.toSession && <span className="tr-chip tr-mono">to {e.toSession}</span>}
                </div>
              </div>
            ))}
            {!escalations.length && <div className="tr-card-ghost p-5 text-[13px]">No undelivered escalation events in the recent hub window.</div>}
          </div>
        </section>

        {gates.length > 0 && (
          <section className="mb-8">
            <h2 className="tr-sec-title">Gates</h2>
            <p className="tr-sec-sub">Each gate keeps the agent positions side by side; a verdict sends one bus message to every named session.</p>
            <div className="mt-3 flex flex-col gap-2">
              {gates.slice(0, 8).map(g => {
                const sessions = eventSessions(g);
                return (
                  <div key={g.id ?? g.ts} className="tr-card p-3.5">
                    <div className="break-words text-[13px] leading-snug">{g.claim || g.detail || "verification gate"}</div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      {[0, 1].map(i => (
                        <div key={i} className="rounded-md border border-[var(--color-tr-edge)] bg-black/10 p-2">
                          <div className="tr-chip tr-mono mb-1">{sessions[i] || `agent ${i + 1}`}</div>
                          <div className="text-[12px] text-[var(--color-tr-muted)]">{g.detail || "No verbatim position attached to this gate event."}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" disabled={!!busy || sessions.length === 0}
                              onClick={() => sendGateVerdict(g, "coordinate directly and report the settled result on the bus")}
                              className="tr-chip hover:text-[var(--color-tr-doing)] disabled:opacity-40">
                        <Activity size={12} /> Coordinate
                      </button>
                      <button type="button" disabled={!!busy || sessions.length === 0}
                              onClick={() => sendGateVerdict(g, "hold changes until the gate is independently resolved")}
                              className="tr-chip hover:text-[var(--color-tr-warn)] disabled:opacity-40">
                        <ShieldCheck size={12} /> Hold
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h2 className="tr-sec-title">Watch map</h2>
          <p className="tr-sec-sub">Autonomy level per project and codependency links. Edits run through the same `trantor policy` CLI bridges.</p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-4">
            <div className="tr-card p-3.5">
              <div className="mb-2 text-[12px] text-[var(--color-tr-muted)]">Autonomy ladder</div>
              <div className="flex flex-col gap-2">
                {projects.map(proj => {
                  const lvl = status.autonomy[proj] ?? status.autonomy["*"] ?? 1;
                  const setLevel = (n: number) => void run(`level-${proj}`, () => policySet(proj, n));
                  return (
                    <div key={proj} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{proj}</span>
                      <button type="button" disabled={!!busy || lvl <= 1} onClick={() => setLevel(lvl - 1)}
                              className="tr-chip px-2 disabled:opacity-40" title="Decrease autonomy level"><Minus size={12} /></button>
                      <span className="tr-chip w-20 justify-center">{lvl} {dictGet(LEVEL_LABEL, String(lvl))}</span>
                      <button type="button" disabled={!!busy || lvl >= 4} onClick={() => setLevel(lvl + 1)}
                              className="tr-chip px-2 disabled:opacity-40" title="Increase autonomy level"><Plus size={12} /></button>
                    </div>
                  );
                })}
                {!projects.length && <div className="text-[13px] text-[var(--color-tr-muted)]">Whole fleet at level {status.autonomy["*"] ?? 1}.</div>}
              </div>
            </div>

            <div className="tr-card p-3.5">
              <div className="mb-2 text-[12px] text-[var(--color-tr-muted)]">Project links</div>
              <div className="flex flex-col gap-2">
                {status.links.map(l => (
                  <div key={l.projects.join("\0")} className="rounded-md border border-[var(--color-tr-edge)] bg-black/10 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {l.projects.map(p => <span key={p} className="tr-chip">{p}</span>)}
                      <button type="button" disabled={!!busy} onClick={() => void run(`unlink-${l.projects.join("-")}`, () => policyUnlink(l.projects))}
                              className="tr-chip ml-auto hover:text-[var(--color-tr-fail)] disabled:opacity-40" title="Unlink this pair">
                        <Unlink size={12} /> Unlink
                      </button>
                    </div>
                    <div className="mt-1.5 text-[12px] text-[var(--color-tr-muted)]">{l.reason || "linked"}</div>
                  </div>
                ))}
                {!status.links.length && <div className="text-[13px] text-[var(--color-tr-muted)]">No codependency links declared.</div>}
                <div className="mt-2 grid gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input className="tr-input" value={linkA} onChange={e => setLinkA(e.target.value)} placeholder="project A" />
                    <input className="tr-input" value={linkB} onChange={e => setLinkB(e.target.value)} placeholder="project B" />
                  </div>
                  <input className="tr-input" value={linkReason} onChange={e => setLinkReason(e.target.value)} placeholder="reason" />
                  <button type="button" disabled={!!busy || !linkA.trim() || !linkB.trim() || !linkReason.trim()}
                          onClick={() => void run("link", async () => {
                            const out = await policyLink([linkA.trim(), linkB.trim()], linkReason.trim());
                            setLinkA(""); setLinkB(""); setLinkReason("");
                            return out;
                          })}
                          className="tr-chip w-fit px-3 py-1.5 hover:text-[var(--color-tr-ok)] disabled:opacity-40">
                    <Link2 size={12} /> Link projects
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
