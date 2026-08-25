// INBOX — ONLY what needs an answer from you, across every project.
//
// Scope correction: this used to hold every message the hub would hand over, broadcasts included,
// which buried the handful that actually wanted a human. Agent-to-agent traffic now lives in each
// project's Conversation, where it belongs and where the roster gives it context. What is left here
// is the question Sasha actually asks of an inbox: "is anything waiting on ME?"
//
// Reads with peek=1 on purpose. The app is a viewer; advancing the delivery ledger because a human
// glanced at a list would hide the message from the receiving SESSION's hooks, which are the thing
// that actually acts on it. Marking-as-read is the agent's business, not the dashboard's.
import { useEffect, useRef, useState } from "react";
import { hasSeen, markSeen } from "../../shared/seen";
import { stalenessOf } from "./staleness";
import type { Card, HubClient, Message, Peer } from "../../shared/api/client";
import { Avatar } from "../../shared/Avatar";
import { Composer } from "../../shared/Composer";
import { ago, when } from "../../shared/time";

const brandOf = (s: string) => s.split(":")[0] ?? s;



// QUICK ACTIONS — answer without leaving the row.
//
// "Reply to X" only set the recipient on the footer composer, so answering a yes/no question meant
// three moves: click, scroll, type. The inbox exists to hold decisions that are waiting on a human,
// and a decision you cannot take in one click isn't really in an inbox, it's in a queue.
//
// The three canned answers are deliberately blunt and few. A longer menu becomes a thing to read,
// which is the cost this is meant to remove; anything subtler goes in the free-text box next to
// them. Sending marks the message read, because answering IS reading, and the badge drops at once.
const QUICK_ANSWERS = ["Go ahead", "No", "Hold off for now"] as const;

function QuickActions({ msg, client, onSent, onOpenConversation }: {
  msg: Message;
  client: HubClient;
  onSent: () => void;
  onOpenConversation?: (session: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const [err, setErr] = useState("");

  const reply = async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true); setErr("");
    try {
      await client.send(msg.from, trimmed, msg.project);
      markSeen(msg.id);          // answered is read; the badge drops without waiting for a poll
      setSent(trimmed);
      setOpen(false); setText("");
      onSent();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="mt-2 text-[12px] text-[var(--color-tr-muted)]">
        replied to {brandOf(msg.from)}: <span className="opacity-80">{sent}</span>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {QUICK_ANSWERS.map(a => (
          <button key={a} onClick={() => void reply(a)} disabled={busy}
                  className="tr-chip hover:text-[var(--color-tr-doing)] disabled:opacity-50">
            {a}
          </button>
        ))}
        <button onClick={() => setOpen(o => !o)} disabled={busy}
                className="text-[var(--color-tr-muted)] hover:text-[var(--color-tr-doing)]">
          {open ? "Cancel" : "Reply…"}
        </button>
        {onOpenConversation && (
          <button onClick={() => onOpenConversation(msg.from)}
                  className="text-[var(--color-tr-muted)] hover:text-[var(--color-tr-doing)]">
            View conversation
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex gap-2">
          <input autoFocus value={text} onChange={e => setText(e.target.value)}
                 onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void reply(text); } }}
                 placeholder={`Reply to ${msg.from}`} className="tr-input flex-1" />
          <button onClick={() => void reply(text)} disabled={busy || !text.trim()}
                  className="tr-chip disabled:opacity-40">Send</button>
        </div>
      )}
      {err && <div className="mt-1 text-[11px] text-[var(--color-tr-fail)]">{err}</div>}
    </div>
  );
}

// A row marks itself read once it has actually been ON SCREEN, not merely rendered. The badge is a
// human-side count (shared/seen.ts), so "read" has to mean the human could see it: a list that
// marks everything read on mount would clear the badge for messages scrolled past in a blink.
// Half-visible for 600ms is the bar, which a glance clears and a scroll-by does not.
function MessageRow({ id, dim, children }: { id: number; dim?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || hasSeen(id)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const obs = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { if (!timer) timer = setTimeout(() => markSeen(id), 600); }
      else if (timer) { clearTimeout(timer); timer = null; }
    }, { threshold: 0.5 });
    obs.observe(el);
    return () => { if (timer) clearTimeout(timer); obs.disconnect(); };
  }, [id]);
  return <div ref={ref} className={`tr-card mb-2.5 flex gap-3 p-4 ${dim ? "opacity-55" : ""}`}>{children}</div>;
}

export function Inbox({ client, me, onOpenConversation }: {
  client: HubClient; me: string; onOpenConversation?: (session: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [staleOpen, setStaleOpen] = useState<Record<number, boolean>>({});
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Filter to DIRECT only. The hub's deliverable() also hands over broadcasts (to === "all"), and
  // those are FYI — the same distinction the notification policy and T2's block-the-stop rule use.
  const load = () => client.inbox(me)
    .then(r => setMessages((r.messages ?? []).filter(m => m.to === me).reverse()))
    .catch(e => setErr(String(e.message || e)));
  useEffect(() => {
    // Refreshed, not snapshotted. Fetching these once on mount and then reasoning about them
    // against a live clock is exactly how a healthy seat got reported as gone.
    const refresh = () => {
      load();
      client.peers().then(setPeers).catch(() => {});
      client.tasks().then(setCards).catch(() => {});   // card status is how we know the work moved on
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [client, me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => client.streamEvents(ev => { if (ev.type === "message") load(); }), [client, me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Computed once per render rather than per row: the bulk action and the rows must agree about
  // what is stale, or "Dismiss all 6" leaves something behind and the count stops being trustworthy.
  const staleIds = messages.filter(m => stalenessOf(m, messages, peers, cards).stale).map(m => m.id);
  const staleCount = staleIds.filter(id => !hasSeen(id)).length;
  const dismissStale = () => { for (const id of staleIds) markSeen(id); load(); };

  const submit = async () => {
    if (!to || !text.trim() || sending) return;
    setSending(true); setErr(null);
    try { await client.send(to, text.trim()); setText(""); load(); }
    catch (e) { setErr(e instanceof Error && e.message ? e.message : String(e)); }
    finally { setSending(false); }
  };

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Inbox</h1>
        <p className="tr-page-sub">Messages that need an answer from you.</p>
        {staleCount > 0 && (
          <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--color-tr-muted)]">
            <span>
              {staleCount} of {messages.length} {staleCount === 1 ? "has" : "have"} gone stale —
              the card is closed, or they asked again since.
            </span>
            <button onClick={dismissStale} className="tr-chip hover:text-[var(--color-tr-doing)]">
              Dismiss {staleCount === 1 ? "it" : "all " + staleCount}
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-4">
        {messages.map(m => {
          const st = stalenessOf(m, messages, peers, cards);
          return (
          <MessageRow key={m.id} id={m.id} dim={st.stale}>
            <Avatar name={m.from} size={34} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold">{m.from}</span>
                {m.project && <span className="tr-chip shrink-0">{m.project}</span>}
                <span className="ml-auto shrink-0 text-[11px] text-[var(--color-tr-muted)]">
                  {when(m.ts)}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                  Date.now() - m.ts > 24 * 60 * 60 * 1000
                    ? "bg-[var(--color-tr-warn)]/15 text-[var(--color-tr-warn)]"
                    : "bg-white/[0.05] text-[var(--color-tr-muted)]"}`}>
                  waiting {ago(m.ts)}
                </span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{m.text}</div>
              {st.stale ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--color-tr-muted)]">
                  <span className="tr-chip">stale — {st.reason}</span>
                  <button onClick={() => markSeen(m.id)} className="hover:text-[var(--color-tr-doing)]">Dismiss</button>
                  <button onClick={() => setStaleOpen(o => ({ ...o, [m.id]: !o[m.id] }))}
                          className="hover:text-[var(--color-tr-doing)]">
                    {staleOpen[m.id] ? "Never mind" : "Answer anyway"}
                  </button>
                  {onOpenConversation && (
                    <button onClick={() => onOpenConversation(m.from)} className="hover:text-[var(--color-tr-doing)]">
                      View conversation
                    </button>
                  )}
                </div>
              ) : null}
              {(!st.stale || staleOpen[m.id]) && (
                <QuickActions msg={m} client={client} onSent={load} onOpenConversation={onOpenConversation} />
              )}
            </div>
          </MessageRow>
          );
        })}
        {!messages.length && (
          <div className="tr-card-ghost flex flex-col items-center justify-center gap-1 p-10 text-center">
            <span className="text-[13px]">Nothing waiting on you.</span>
            <span className="text-[12px] opacity-70">Agent-to-agent traffic lives in each project's conversation.</span>
          </div>
        )}
      </div>

      <div className="px-10 pb-5">
        {err && <div className="mb-2 text-[11px] text-[var(--color-tr-fail)]">{err}</div>}
        <Composer value={text} onChange={setText} onSend={() => void submit()}
                  placeholder={to ? `Message ${to}` : "Pick a recipient…"}
                  busy={sending} disabled={!to || !text.trim()}
                  left={
                    <select value={to} onChange={e => setTo(e.target.value)}
                            className="tr-input w-48 shrink-0 border-0 bg-transparent">
                      <option value="">to…</option>
                      <option value="all">all (broadcast)</option>
                      {peers.map(p => <option key={p.session} value={p.session}>{p.session}</option>)}
                    </select>
                  } />
      </div>
    </div>
  );
}
