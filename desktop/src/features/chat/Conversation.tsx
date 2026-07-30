// CONVERSATION — the project's own channel. This is where the agents talk to EACH OTHER.
//
// Corrects a scoping mistake: the first cut had one global Inbox holding everything, which buried
// the thing that matters most. The two are different questions:
//
//   this view   "what are the agents on crebral-scribe saying to each other right now?"
//   Inbox       "what needs an answer from ME?"
//
// A project is a channel. The roster sits beside the conversation on purpose — knowing WHO is in the
// room while they talk is most of the context, and it is exactly what the operator loses when they
// have to read two terminal windows to follow one exchange.
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient, HubEvent, Peer } from "../../shared/api/client";
import { ProjectHeader } from "../project/ProjectHeader";
import { Avatar, displayName } from "../../shared/Avatar";
import { Composer } from "../../shared/Composer";
import { CardDetail } from "../board/CardDetail";
import { cleanTitle } from "../../shared/Avatar";

const ONLINE_MS = 5 * 60 * 1000;
const BUSY_MS = 90 * 1000;

function presence(p: Peer) {
  const age = Date.now() - (p.lastSeen ?? 0);
  if (age > ONLINE_MS) return { label: "offline", color: "var(--color-tr-edge)" };
  if (age < BUSY_MS) return { label: "working", color: "var(--color-tr-doing)" };
  return { label: "idle", color: "var(--color-tr-muted)" };
}

type Msg = { id: number; ts: number; by: string; text: string; to: string };

// Day dividers the way every messenger does them: messages read as a day's conversation, not a log.
function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Conversation({ client, project, me, lens, onLens }: {
  client: HubClient; project: string; me: string; lens: string; onLens: (l: string) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [to, setTo] = useState("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cards, setCards] = useState<Map<number, Card>>(new Map());
  const [openCard, setOpenCard] = useState<number | null>(null);

  // Messages come from the event log rather than /inbox: /inbox is per-recipient, and this view is
  // the whole ROOM — including traffic between two agents that was never addressed to us.
  const load = () => client.events({ project, type: "message", limit: 200 })
    .then(r => setMsgs(toMsgs(r.events ?? [])))
    .catch(e => setErr(String(e.message || e)));

  useEffect(() => { setMsgs([]); setErr(null); load(); }, [client, project]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => client.peers().then(setPeers).catch(() => {}), 15000);
    client.peers().then(setPeers).catch(() => {});
    return () => clearInterval(t);
  }, [client]);

  useEffect(() => {
    client.tasks(project).then(ts => setCards(new Map(ts.map(t => [t.id, t])))).catch(() => {});
  }, [client, project]);

  useEffect(() => client.streamEvents(ev => {
    if (ev.type === "message" && ev.project === project) {
      setMsgs(prev => [...prev, ...toMsgs([ev])].slice(-300));
    }
    if (ev.type?.startsWith("presence")) client.peers().then(setPeers).catch(() => {});
  }), [client, project]);

  const roster = useMemo(
    () => peers.filter(p => p.project === project)
               .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)),
    [peers, project]);
  const peerOf = useMemo(() => {
    const m = new Map(peers.map(p => [p.session, p]));
    return (session: string) => m.get(session);
  }, [peers]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await client.send(to, text.trim(), project); setText(""); load(); }
    catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };

  // The chat is THREADED, not flat: a run of consecutive messages about the same card (#N refs —
  // invariant 3, threads are derived) folds into one thread block with the card's narrative as its
  // title. Messages about nothing in particular stay chronological. Within any run, consecutive
  // messages by one sender group the way Slack/Buzz group them.
  const primaryRef = (m: Msg) => { const x = /#(\d{2,7})(?![0-9])/.exec(m.text); return x ? Number(x[1]) : null; };
  type Item =
    | { kind: "day"; label: string }
    | { kind: "msg"; m: Msg; first: boolean }
    | { kind: "thread"; ref: number; msgs: Msg[] };
  const rows = useMemo(() => {
    const out: Item[] = [];
    let lastDay = "", lastBy = "", lastTs = 0;
    const flushable: Msg[] = [];
    let runRef: number | null = null;
    const flushRun = () => {
      if (!flushable.length) return;
      if (runRef !== null && flushable.length >= 2) out.push({ kind: "thread", ref: runRef, msgs: [...flushable] });
      else for (const m of flushable) {
        const first = m.by !== lastBy || m.ts - lastTs > 5 * 60 * 1000;
        out.push({ kind: "msg", m, first });
        lastBy = m.by; lastTs = m.ts;
      }
      flushable.length = 0;
    };
    for (const m of msgs) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { flushRun(); runRef = null; out.push({ kind: "day", label: day }); lastDay = day; lastBy = ""; lastTs = 0; }
      const ref = primaryRef(m);
      if (ref !== runRef) { flushRun(); runRef = ref; }
      flushable.push(m);
    }
    flushRun();
    return out;
  }, [msgs]);

  const threadTitle = (ref: number) => {
    const c = cards.get(ref);
    return c ? (c.summary || cleanTitle(c.title)) : `card #${ref}`;
  };

  return (
    <div className="tr-pane relative flex h-full flex-col">
      <ProjectHeader project={project} lens={lens} onLens={onLens}
        sub={<>{roster.length} in the room · agents talking to each other</>} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-8 py-2">
            {err && <div className="mb-2 text-[11px] text-[var(--color-tr-fail)]">{err}</div>}
            {!msgs.length && (
              /* the beginning of a channel is an invitation, not dead space */
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Avatar name={project} size={64} />
                <div className="tr-sec-title">#{project}</div>
                <div className="max-w-sm text-[13px] text-[var(--color-tr-muted)]">
                  This is the beginning of {project}'s channel. Messages between every agent on the
                  project land here.
                </div>
              </div>
            )}
            {(() => {
              const MsgRow = ({ m, first, dense }: { m: Msg; first: boolean; dense?: boolean }) => (
                <div className={`flex gap-3 ${first ? (dense ? "mt-2.5" : "mt-4") : "mt-0.5"}`}>
                  <span className="w-[30px] shrink-0">
                    {first && <Avatar name={m.by} llm={peerOf(m.by)?.llm} size={30} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    {first && (
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-semibold"
                              style={m.by === me ? { color: "var(--color-tr-ok)" } : undefined}>
                          {displayName(m.by, peerOf(m.by)?.llm)}
                        </span>
                        {peerOf(m.by)?.model && <span className="tr-chip tr-mono">{peerOf(m.by)!.model}</span>}
                        {m.to !== "all" && (
                          <span className="tr-chip"
                                style={m.to === me ? { color: "var(--color-tr-doing)" } : undefined}>
                            → {m.to.split(":")[0]}
                          </span>
                        )}
                        <span className="text-[11px] text-[var(--color-tr-muted)]">
                          {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{m.text}</div>
                  </div>
                </div>
              );
              return rows.map((r, i) => {
                if (r.kind === "day") return (
                  <div key={`d${i}`} className="my-4 flex items-center gap-3">
                    <span className="h-px flex-1 bg-[var(--color-tr-edge)]" />
                    <span className="text-[11px] text-[var(--color-tr-muted)]">{r.label}</span>
                    <span className="h-px flex-1 bg-[var(--color-tr-edge)]" />
                  </div>
                );
                if (r.kind === "thread") {
                  let lastBy = "", lastTs = 0;
                  return (
                    <div key={`t${i}`} className="mt-4 overflow-hidden rounded-xl border border-[var(--color-tr-edge)] bg-white/[0.02]">
                      <button onClick={() => setOpenCard(r.ref)}
                              className="flex w-full items-center gap-2 border-b border-[var(--color-tr-edge)] px-3.5 py-2 text-left hover:bg-white/[0.03]">
                        <span className="text-[12px]">🧵</span>
                        <span className="tr-mono shrink-0 text-[11px] text-[var(--color-tr-muted)]">#{r.ref}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{threadTitle(r.ref)}</span>
                        <span className="shrink-0 text-[11px] text-[var(--color-tr-muted)]">{r.msgs.length} messages · open card →</span>
                      </button>
                      <div className="px-3.5 pb-3">
                        {r.msgs.map((m, j) => {
                          const first = m.by !== lastBy || m.ts - lastTs > 5 * 60 * 1000;
                          lastBy = m.by; lastTs = m.ts;
                          return <MsgRow key={m.id + ":" + j} m={m} first={first} dense />;
                        })}
                      </div>
                    </div>
                  );
                }
                return <MsgRow key={r.m.id + ":" + i} m={r.m} first={r.first} />;
              });
            })()}
          </div>

          <div className="px-8 pb-5 pt-2">
            <Composer value={text} onChange={setText} onSend={() => void send()}
                      placeholder={`Message #${project}`} busy={busy} disabled={!text.trim()}
                      left={
                        <select value={to} onChange={e => setTo(e.target.value)}
                                className="tr-input w-40 shrink-0 border-0 bg-transparent">
                          <option value="all">everyone</option>
                          {roster.map(p => <option key={p.session} value={p.session}>{p.session}</option>)}
                        </select>
                      } />
          </div>
        </div>

        {/* Who is in the room, right now. */}
        <aside className="w-60 shrink-0 overflow-y-auto border-l border-[var(--color-tr-edge)] px-4 py-3">
          <div className="tr-label mb-3">in this project · {roster.length}</div>
          {roster.map(p => {
            const st = presence(p);
            return (
              <div key={p.session} className="mb-3 flex items-center gap-2.5">
                <span className="relative shrink-0">
                  <Avatar name={p.session} llm={p.llm} size={28} />
                  <span className="tr-dot absolute -right-0.5 -bottom-0.5 border-2 border-[var(--color-tr-main)]"
                        style={{ background: st.color, width: 9, height: 9 }} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{displayName(p.session, p.llm)}</div>
                  <div className="truncate text-[11px] text-[var(--color-tr-muted)]">
                    {p.model ? <span className="tr-mono">{p.model}</span> : st.label}{p.status ? ` · ${p.status}` : ""}
                  </div>
                </div>
              </div>
            );
          })}
          {!roster.length && <div className="text-[12px] text-[var(--color-tr-muted)]">Nobody here.</div>}
        </aside>
      </div>
      {openCard !== null && <CardDetail client={client} id={openCard} onClose={() => setOpenCard(null)} />}
    </div>
  );
}

// Message events carry `refs[]`, never taskId — invariant 2 of the event log. The payload keys are
// msgId/toSession/text, flattened onto the event.
function toMsgs(events: HubEvent[]): Msg[] {
  return events
    .filter(e => e.type === "message")
    .map(e => {
      const a = e as Record<string, unknown>;
      return {
        id: Number(a.msgId ?? e.id ?? e.ts),
        ts: e.ts,
        by: String(e.by ?? "?"),
        to: String(a.toSession ?? "all"),
        text: String(a.text ?? ""),
      };
    })
    .sort((x, y) => x.ts - y.ts);
}
