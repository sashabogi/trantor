// MESSAGES — the fleet's conversations, Buzz/Slack-shaped: a list of who-is-talking-to-whom on
// the left, the actual back-and-forth on the right, live.
//
// Sasha (2026-08-13): "How do I see when the cross-session communication is happening? Unless
// you're looking at the terminal windows while it's happening, you will never know there was any
// interchange." He was right: agent↔agent DMs (health ↔ scribe planning a schema, duty's nudges)
// rendered NOWHERE — the Chat lens is per-project, the Inbox is only what's addressed to the
// human. This view is the missing surface.
//
// Data: zero new hub machinery. Every /send appends a `message` EVENT to the one log; /events
// without a project filter returns everything the signed-in identity may read; the SSE stream
// pushes new ones. Conversations are a client-side GROUPING of that log:
//   • a DM thread per unordered session pair   (crebral-health ↔ crebral-scribe)
//   • a broadcast thread per project           (# crebral-health — to:"all" announcements)
//
// Watching AND interjecting (v2 — "does that even work?"): every DM thread composes. On a pair
// thread between two agents the composer carries a recipient toggle, and the thread FOLDS IN the
// human's own exchanges with either party — an interjection and its answer render right where the
// conversation is happening, not in some other thread. Delivery is the same signed /send every
// agent uses; an idle interactive recipient gets woken by the duty seat's cross-session nudge
// (proven end-to-end 2026-08-13). "New message" starts a conversation with any live session —
// including the duty seat, which is the fleet's acting brain and the address for "tell the
// overseer something".
import { useEffect, useMemo, useRef, useState } from "react";
import type { HubClient, HubEvent, Peer } from "../../shared/api/client";
import { Avatar, BrandGlyph, displayName } from "../../shared/Avatar";
import { Composer } from "../../shared/Composer";
import { clock, when } from "../../shared/time";

type Msg = { id: number; ts: number; from: string; to: string; project: string; text: string };

type Thread = {
  key: string;
  kind: "dm" | "broadcast";
  /** dm: the two sessions; broadcast: the sender set (grows as senders appear) */
  parties: string[];
  project: string;
  msgs: Msg[];
};

/** The name a human recognizes, per session KIND — the head and tail carry different information
 * for different senders, and picking the wrong half made every pair read "crebral-health ↔
 * crebral-health":
 *   MacBook-Pro-M1:crebral-health → "crebral-health"   (interactive window: machine head is chrome)
 *   glm:crebral-health            → "glm:crebral-health" (crew seat: the AGENT is the identity)
 *   claude:fleet                  → "duty seat"          (the fleet's acting brain, by its job)
 *   sasha@mac                     → "sasha@mac"
 * Full session id stays available as a tooltip wherever this renders. */
const HOSTISH = /^(macbook|imac|mac[-.]|.*\.local$)|@/i;
/** hub:* names are the hub's own synthetic senders (overseer announcements, escalation notices).
 * They WRITE and never read — a message sent to one sits undelivered forever. The UI must not
 * offer them as recipients. */
const isSynthetic = (session: string) => session.startsWith("hub:");
export function shortName(session: string): string {
  if (session === "claude:fleet") return "duty seat";
  const [head, ...rest] = session.split(":");
  const tail = rest.join(":");
  if (!tail) return head;
  return HOSTISH.test(head) ? tail : session;
}

function msgOf(ev: HubEvent): Msg | null {
  const text = String(ev.text ?? "");
  const from = String(ev.by ?? "");
  const to = String((ev as Record<string, unknown>).toSession ?? "");
  if (!text || !from || !to) return null;
  // Sasha's question, answered: "are those even messages and conversations? Or are they notices?"
  // Notices. hub:* traffic is the overseer reporting STATE — it has a real surface (the Overseer
  // view, with per-condition roll-ups) and rendering it here as fake conversations buried every
  // real exchange under walls of boilerplate. Messages is conversations between parties that can
  // actually converse.
  if (isSynthetic(from) || isSynthetic(to)) return null;
  return { id: Number(ev.msgId ?? ev.id ?? 0), ts: ev.ts, from, to, project: String(ev.project ?? ""), text };
}

const pairKey = (a: string, b: string) => [a, b].sort().join(" ");

function threadKey(m: Msg): string {
  if (m.to === "all") return `#${m.project || "fleet"}`;
  return pairKey(m.from, m.to);
}

function buildThreads(msgs: Msg[]): Thread[] {
  const map = new Map<string, Thread>();
  for (const m of msgs) {
    const key = threadKey(m);
    let t = map.get(key);
    if (!t) {
      t = key.startsWith("#")
        ? { key, kind: "broadcast", parties: [], project: m.project, msgs: [] }
        : { key, kind: "dm", parties: key.split(" "), project: m.project, msgs: [] };
      map.set(key, t);
    }
    if (t.kind === "broadcast" && !t.parties.includes(m.from)) t.parties.push(m.from);
    if (m.project && !t.project) t.project = m.project;
    t.msgs.push(m);
  }
  // newest conversation first — the one moving right now is the one being looked for
  return [...map.values()].sort((a, b) => (b.msgs[b.msgs.length - 1]?.ts ?? 0) - (a.msgs[a.msgs.length - 1]?.ts ?? 0));
}

const dayOf = (ts: number) => new Date(ts).toDateString();

// The doctrine rule this view initially broke: any surface that renders a log must ROLL IT UP.
// The hub's overseer notices arrive dozens at a time with near-identical text, and rendering
// them verbatim buried the two real messages in a 150-row wall (Sasha: "unreadable and
// completely useless"). Consecutive synthetic-sender messages collapse into ONE quiet row —
// count + span, expandable — while real agents' words always render in full.
type ThreadItem = { kind: "msg"; msg: Msg } | { kind: "run"; msgs: Msg[] };
function collapseRuns(msgs: Msg[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (isSynthetic(m.from)) {
      if (last?.kind === "run") { last.msgs.push(m); continue; }
      out.push({ kind: "run", msgs: [m] });
    } else {
      out.push({ kind: "msg", msg: m });
    }
  }
  // a lone notice reads fine as a message; only actual RUNS earn the collapse
  return out.map(it => (it.kind === "run" && it.msgs.length === 1 ? { kind: "msg" as const, msg: it.msgs[0] } : it));
}

function PairAvatars({ parties }: { parties: string[] }) {
  return (
    <span className="relative inline-block h-9 w-9 shrink-0">
      <span className="absolute top-0 left-0"><Avatar name={parties[0] ?? "?"} size={26} /></span>
      {parties[1] && (
        <span className="absolute right-0 bottom-0 rounded-full border-2 border-[var(--color-tr-main)]">
          <Avatar name={parties[1]} size={26} />
        </span>
      )}
    </span>
  );
}

export function Messages({ client, me, focus }: { client: HubClient; me: string; focus?: string | null }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  // drafts are PER conversation — a global draft followed the user across threads and re-aimed a
  // half-typed message at a different recipient (found live, first dogfood of the composer)
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  /** pair threads: which party an interjection goes to; keyed per thread so switching threads
   * never silently re-aims a half-typed message */
  const [aim, setAim] = useState<Record<string, string>>({});
  /** a conversation being STARTED — no messages exist yet, so no thread does either */
  const [compose, setCompose] = useState<{ picking: boolean; to: string | null }>({ picking: false, to: null });
  const [pickQ, setPickQ] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [openRuns, setOpenRuns] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    // NO project filter — this is the fleet-wide view; the hub scopes it to what we may read.
    client.events({ type: "message", limit: 2000 })
      .then(r => { if (alive) setMsgs(r.events.map(msgOf).filter((m): m is Msg => !!m)); })
      .catch(e => { if (alive) setError(String(e.message || e)); });
    client.peers().then(ps => { if (alive) setPeers(ps); }).catch(() => {});
    return () => { alive = false; };
  }, [client]);

  useEffect(() => client.streamEvents(ev => {
    if (ev.type !== "message") return;
    const m = msgOf(ev);
    if (m) setMsgs(cur => (cur ? [...cur, m] : cur));
  }), [client]);

  const threads = useMemo(() => buildThreads(msgs ?? []), [msgs]);
  // an Inbox jump lands on the conversation with that sender — existing thread or a fresh compose
  useEffect(() => {
    if (!focus) return;
    const key = pairKey(me, focus);
    setCompose({ picking: false, to: null });
    setSel(key);
  }, [focus, me]);
  // selection is PINNED: pick the newest thread once at load, then never auto-switch — a live
  // message reordering the list must not change what the user is reading or composing into
  useEffect(() => {
    if (sel === null && !compose.to && threads.length) setSel(threads[0].key);
  }, [sel, compose.to, threads]);
  // a focus jump to a pair with no history yet: fall through to compose mode with that peer.
  // Guarded on the log having LOADED — before that, threads is [] for every pair, and this
  // fallback fired during loading, which is why "View conversation" landed on a blank screen.
  useEffect(() => {
    if (msgs !== null && focus && sel === pairKey(me, focus) && !threads.some(t => t.key === sel)) {
      setCompose({ picking: false, to: focus });
      setSel(null);
    }
  }, [msgs, focus, sel, threads, me]);
  const open = threads.find(t => t.key === sel) ?? null;

  // A pair thread folds in the human's own exchanges with either party: the interjection and its
  // answer belong WHERE THE CONVERSATION IS, not in a separate me↔agent thread the human then has
  // to know to go find. (Those me↔agent threads still exist on their own — a message can be worth
  // seeing in two places; hiding it in either would be worse.)
  const openMsgs = useMemo(() => {
    if (!open || open.kind !== "dm") return open?.msgs ?? [];
    const [a, b] = open.parties;
    if (open.parties.includes(me)) return open.msgs;
    const keys = new Set([open.key, pairKey(me, a), pairKey(me, b)]);
    return (msgs ?? []).filter(m => m.to !== "all" && keys.has(threadKey(m)));
  }, [open, msgs, me]);

  // who an interjection goes to: explicit choice first, else whoever spoke last — the party that
  // just said something is almost always the one being answered
  const isPair = !!open && open.kind === "dm" && !open.parties.includes(me);
  const real = (open?.parties ?? []).filter(p => !isSynthetic(p));
  const aimTo = open && isPair
    ? (aim[open.key]
       ?? [...openMsgs].reverse().find(m => real.includes(m.from))?.from
       ?? real[0] ?? null)
    : open?.kind === "dm" ? (open.parties.find(p => p !== me && !isSynthetic(p)) ?? null) : null;
  const composeTo = compose.to;
  const sendTarget = composeTo ?? aimTo;
  const draftKey = composeTo ? `new:${composeTo}` : (open?.key ?? "");
  const draft = drafts[draftKey] ?? "";
  const setDraft = (v: string) => setDrafts(cur => ({ ...cur, [draftKey]: v }));

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [open?.key, openMsgs.length, composeTo]);

  const doSend = () => {
    const text = draft.trim();
    if (!sendTarget || !text || sending) return;
    setSending(true);
    // the stream echoes the message event back, so the thread updates itself
    client.send(sendTarget, text, (open?.project || peers.find(p => p.session === sendTarget)?.project) || undefined)
      .then(() => {
        setDraft("");
        if (composeTo) { setSel(pairKey(me, composeTo)); setCompose({ picking: false, to: null }); }
      })
      .catch(e => setError(String((e as Error).message || e)))
      .finally(() => setSending(false));
  };

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Messages unavailable: {error}</div>;
  if (!msgs) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading conversations…</div>;

  // live sessions the human can start a conversation with — the duty seat pinned first: it is the
  // overseer's acting half, and "tell the overseer something" needs an address, not a mystery
  const startable = [...peers]
    .filter(p => p.session !== me && !isSynthetic(p.session))
    .sort((a, b) => (a.session === "claude:fleet" ? -1 : 0) - (b.session === "claude:fleet" ? -1 : 0) || a.session.localeCompare(b.session));

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Messages</h1>
        <p className="tr-page-sub">Every conversation on the bus — and you can step into any of them.</p>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* conversation list */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r border-[var(--color-tr-edge)] px-4 pb-6">
          <button onClick={() => setCompose(c => ({ picking: !c.picking, to: null }))}
            className="tr-card-ghost mb-2 flex w-full items-center justify-center gap-2 p-2.5 text-[13px]">
            + New message
          </button>
          {compose.picking && (
            <div className="tr-card mb-3 max-h-72 overflow-y-auto p-1.5">
              <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-tr-muted)]/60">To</div>
              <input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)}
                     placeholder="Filter sessions…" className="tr-input mb-1.5 w-full" />
              {startable.length === 0 && <div className="p-3 text-[12px] text-[var(--color-tr-muted)]">No live sessions on this hub.</div>}
              {startable.filter(p => !pickQ.trim() || p.session.toLowerCase().includes(pickQ.trim().toLowerCase())).map(p => (
                <button key={p.session}
                  onClick={() => { setCompose({ picking: false, to: p.session }); setSel(null); setDraft(""); }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]">
                  <Avatar name={p.session} llm={p.llm} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{shortName(p.session)}</span>
                    <span className="tr-mono block truncate text-[10px] text-[var(--color-tr-muted)]">{p.session}</span>
                  </span>
                  {p.session === "claude:fleet" && <span className="tr-chip shrink-0">overseer's hands</span>}
                </button>
              ))}
            </div>
          )}
          {threads.length === 0 && !compose.to && (
            <div className="tr-card-ghost mt-2 p-6 text-center text-[12px]">No bus traffic yet.</div>
          )}
          {threads.map(t => {
            const last = t.msgs[t.msgs.length - 1];
            const on = t.key === (open?.key ?? "");
            return (
              <button key={t.key} onClick={() => { setSel(t.key); setCompose({ picking: false, to: null }); }}
                className={`flex w-full items-center gap-3 rounded-xl p-2.5 text-left ${
                  on ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}>
                {t.kind === "dm"
                  ? <PairAvatars parties={t.parties} />
                  : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-[15px] text-[var(--color-tr-muted)]">#</span>}
                <span className="min-w-0 flex-1">
                  {/* BOTH parties, stacked — a truncated "A ↔ …" made every row a mystery */}
                  {t.kind === "dm" ? (
                    <span className="block">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium">{shortName(t.parties[0] ?? "")}</span>
                        {last && <span className="tr-mono ml-auto shrink-0 text-[10px] text-[var(--color-tr-muted)]">{when(last.ts)}</span>}
                      </span>
                      <span className="block truncate text-[12px] font-medium text-[var(--color-tr-text)]/80">↔ {shortName(t.parties[1] ?? "")}</span>
                    </span>
                  ) : (
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium"># {t.key.slice(1)}</span>
                      {last && <span className="tr-mono ml-auto shrink-0 text-[10px] text-[var(--color-tr-muted)]">{when(last.ts)}</span>}
                    </span>
                  )}
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--color-tr-muted)]">
                    {last ? `${shortName(last.from)}: ${last.text}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
          {threads.length > 0 && (
            <div className="px-2 pt-3 text-[11px] leading-relaxed text-[var(--color-tr-muted)]/60">
              Overseer and system notices aren't conversations — they live in the Overseer view.
            </div>
          )}
        </aside>

        {/* thread */}
        <section className="flex min-w-0 flex-1 flex-col">
          {compose.to ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-[var(--color-tr-edge)] px-6 py-3">
                <Avatar name={compose.to} size={24} />
                <span className="text-[14px] font-semibold">{shortName(compose.to)}</span>
                <span className="tr-mono text-[11px] text-[var(--color-tr-muted)]">{compose.to}</span>
              </div>
              <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-tr-muted)]">
                Start the conversation — your message travels the same signed bus the agents use.
              </div>
              <div className="border-t border-[var(--color-tr-edge)] px-6 py-3">
                <Composer value={draft} onChange={setDraft} busy={sending}
                          placeholder={`Message ${shortName(compose.to)}`} onSend={doSend} />
              </div>
            </>
          ) : !open ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-tr-muted)]">
              Pick a conversation, or start one.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2.5 border-b border-[var(--color-tr-edge)] px-6 py-3">
                {open.kind === "dm"
                  ? <>
                      <span className="text-[14px] font-semibold">{open.parties.map(shortName).join(" ↔ ")}</span>
                      {open.parties.map(p => (
                        <span key={p} className="tr-chip" title={p}>
                          <BrandGlyph name={p} size={11} />
                          <span className="tr-mono">{p}</span>
                        </span>
                      ))}
                    </>
                  : <span className="text-[14px] font-semibold"># {open.key.slice(1)} <span className="ml-1 font-normal text-[var(--color-tr-muted)]">broadcasts</span></span>}
                <span className="tr-mono ml-auto text-[11px] text-[var(--color-tr-muted)]">{openMsgs.length} message{openMsgs.length === 1 ? "" : "s"}</span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {(() => {
                  const items = collapseRuns(openMsgs);
                  let lastTs = 0;
                  return items.map((it, i) => {
                    const ts = it.kind === "msg" ? it.msg.ts : it.msgs[0].ts;
                    const newDay = i === 0 || dayOf(lastTs) !== dayOf(ts);
                    const divider = newDay && (
                      <div className="my-4 flex items-center gap-3 text-[11px] text-[var(--color-tr-muted)]">
                        <span className="h-px flex-1 bg-[var(--color-tr-edge)]" />
                        {new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                        <span className="h-px flex-1 bg-[var(--color-tr-edge)]" />
                      </div>
                    );
                    if (it.kind === "run") {
                      const runKey = `${it.msgs[0].id}-${it.msgs[0].ts}`;
                      const expanded = !!openRuns[runKey];
                      const span = dayOf(it.msgs[0].ts) === dayOf(it.msgs[it.msgs.length - 1].ts)
                        ? `${clock(it.msgs[0].ts)} → ${clock(it.msgs[it.msgs.length - 1].ts)}`
                        : `${when(it.msgs[0].ts)} → ${when(it.msgs[it.msgs.length - 1].ts)}`;
                      lastTs = it.msgs[it.msgs.length - 1].ts;
                      return (
                        <div key={runKey}>
                          {divider}
                          <button
                            onClick={() => setOpenRuns(cur => ({ ...cur, [runKey]: !expanded }))}
                            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--color-tr-edge)] px-3 py-1.5 text-left text-[11px] text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">
                            <span>{expanded ? "▾" : "▸"}</span>
                            <span>
                              <span className="tr-mono">{it.msgs.length}</span> overseer/system notices
                            </span>
                            <span className="tr-mono ml-auto">{span}</span>
                          </button>
                          {expanded && (
                            <div className="mt-1 border-l border-[var(--color-tr-edge)] pl-3">
                              {it.msgs.map(m => (
                                <div key={`${m.id}-${m.ts}`} className="mt-2 text-[11px] leading-relaxed text-[var(--color-tr-muted)]">
                                  <span className="tr-mono mr-2">{clock(m.ts)}</span>
                                  <span className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    const m = it.msg;
                    const prevItem = items[i - 1];
                    const prevMsg = prevItem?.kind === "msg" ? prevItem.msg : null;
                    const grouped = !newDay && prevMsg && prevMsg.from === m.from && prevMsg.to === m.to && m.ts - prevMsg.ts < 5 * 60 * 1000;
                    const interjection = isPair && (m.from === me || m.to === me);
                    lastTs = m.ts;
                    return (
                      <div key={`${m.id}-${m.ts}`}>
                        {divider}
                        <div className={`flex gap-3 ${grouped ? "mt-0.5 pl-[44px]" : "mt-3"} ${interjection ? "rounded-lg bg-white/[0.02] py-1 pr-2 -mr-2" : ""}`}>
                          {!grouped && <Avatar name={m.from} size={32} />}
                          <div className="min-w-0 flex-1">
                            {!grouped && (
                              <div className="flex items-baseline gap-2">
                                <span className="text-[13px] font-semibold" title={m.from}>{displayName(m.from)}</span>
                                {interjection && <span className="tr-chip">→ {shortName(m.to)}</span>}
                                {open.kind === "broadcast" && <span className="tr-mono text-[10px] text-[var(--color-tr-muted)]" title={m.from}>{m.from}</span>}
                                <span className="tr-mono text-[10px] text-[var(--color-tr-muted)]">{clock(m.ts)}</span>
                              </div>
                            )}
                            <div className="text-[13px] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {m.text}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
                <div ref={bottomRef} />
              </div>

              {open.kind === "dm" && sendTarget ? (
                <div className="border-t border-[var(--color-tr-edge)] px-6 py-3">
                  <Composer value={draft} onChange={setDraft} busy={sending}
                    placeholder={`Message ${shortName(sendTarget)}`}
                    onSend={doSend}
                    left={isPair && real.length > 1 ? (
                      <span className="tr-seg shrink-0">
                        {real.map(p => (
                          <button key={p} data-on={aimTo === p} title={p}
                                  onClick={() => setAim(cur => ({ ...cur, [open.key]: p }))}>
                            {shortName(p)}
                          </button>
                        ))}
                      </span>
                    ) : undefined} />
                </div>
              ) : open.kind === "dm" ? (
                <div className="border-t border-[var(--color-tr-edge)] px-6 py-3 text-[12px] text-[var(--color-tr-muted)]">
                  These are the hub's own announcements — it doesn't read replies. To act on one, message the duty seat.
                </div>
              ) : (
                <div className="border-t border-[var(--color-tr-edge)] px-6 py-3 text-[12px] text-[var(--color-tr-muted)]">
                  Broadcasts are agents announcing to everyone; there's nothing to reply to here.
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
