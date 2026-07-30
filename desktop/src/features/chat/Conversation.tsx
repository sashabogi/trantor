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
import type { HubClient, HubEvent, Peer } from "../../shared/api/client";
import { ProjectHeader } from "../project/ProjectHeader";

const ONLINE_MS = 5 * 60 * 1000;
const BUSY_MS = 90 * 1000;
const brandOf = (s: string) => s.split(":")[0] ?? s;

function presence(p: Peer) {
  const age = Date.now() - (p.lastSeen ?? 0);
  if (age > ONLINE_MS) return { label: "offline", color: "var(--color-tr-edge)" };
  if (age < BUSY_MS) return { label: "working", color: "var(--color-tr-doing)" };
  return { label: "idle", color: "var(--color-tr-muted)" };
}

type Msg = { id: number; ts: number; by: string; text: string; to: string };

export function Conversation({ client, project, me, lens, onLens }: {
  client: HubClient; project: string; me: string; lens: string; onLens: (l: string) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [to, setTo] = useState("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Messages come from the event log rather than /inbox: /inbox is per-recipient, and this view is
  // the whole ROOM — including traffic between two agents that was never addressed to us.
  const load = () => client.events({ project, type: "message", limit: 200 })
    .then(r => setMsgs(toMsgs(r.events ?? [])))
    .catch(e => setErr(String(e.message || e)));

  useEffect(() => { setMsgs([]); setErr(null); load(); }, [client, project]);

  useEffect(() => {
    const t = setInterval(() => client.peers().then(setPeers).catch(() => {}), 15000);
    client.peers().then(setPeers).catch(() => {});
    return () => clearInterval(t);
  }, [client]);

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

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await client.send(to, text.trim(), project); setText(""); load(); }
    catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="tr-pane flex h-full flex-col">
      <ProjectHeader project={project} lens={lens} onLens={onLens}
        sub={<>{roster.length} in the room · agents talking to each other</>} />
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-8 py-2">
          {err && <div className="mb-2 text-[11px] text-[var(--color-tr-fail)]">{err}</div>}
          {msgs.map(m => {
            const mine = m.by === me;
            const toMe = m.to === me;
            return (
              <div key={m.id} className="mb-3">
                <div className="mb-0.5 flex items-center gap-2 text-[11px] text-[var(--color-tr-muted)]">
                  <span style={{ color: mine ? "var(--color-tr-ok)" : undefined }}>{m.by}</span>
                  {m.to !== "all" && (
                    <span className="rounded px-1.5" style={{
                      background: toMe ? "var(--color-tr-doing)" : "transparent",
                      color: toMe ? "#fff" : "var(--color-tr-muted)",
                      border: toMe ? "none" : "1px solid var(--color-tr-edge)" }}>
                      → {m.to}
                    </span>
                  )}
                  <span className="ml-auto">{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-sm">{m.text}</div>
              </div>
            );
          })}
          {!msgs.length && <div className="p-4 text-sm text-[var(--color-tr-muted)]">No conversation in {project} yet.</div>}
        </div>

        <div className="border-t border-[var(--color-tr-edge)] px-8 py-4">
          <div className="flex gap-2">
            <select value={to} onChange={e => setTo(e.target.value)}
                    className="tr-input w-52 shrink-0">
              <option value="all">everyone in {project}</option>
              {roster.map(p => <option key={p.session} value={p.session}>{p.session}</option>)}
            </select>
            <input value={text} onChange={e => setText(e.target.value)}
                   onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                   placeholder={`message ${project}…`}
                   className="tr-input min-w-0 flex-1" />
            <button onClick={() => void send()} disabled={!text.trim() || busy}
                    className="shrink-0 rounded-lg bg-[var(--color-tr-doing)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
              {busy ? "…" : "send"}
            </button>
          </div>
        </div>
      </div>

      {/* Who is in the room, right now. */}
      <aside className="w-56 shrink-0 overflow-y-auto border-l border-[var(--color-tr-edge)] p-3">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-tr-muted)]">
          in this project · {roster.length}
        </div>
        {roster.map(p => {
          const st = presence(p);
          return (
            <div key={p.session} className="mb-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: st.color }} />
                <span className="truncate">{brandOf(p.session)}</span>
              </div>
              <div className="truncate pl-4 text-[10px] text-[var(--color-tr-muted)]">{st.label}{p.status ? ` · ${p.status}` : ""}</div>
            </div>
          );
        })}
        {!roster.length && <div className="text-[11px] text-[var(--color-tr-muted)]">Nobody here.</div>}
      </aside>
      </div>
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
