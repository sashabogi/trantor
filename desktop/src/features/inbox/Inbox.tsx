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
import { useEffect, useState } from "react";
import type { HubClient, Message, Peer } from "../../shared/api/client";

export function Inbox({ client, me }: { client: HubClient; me: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Filter to DIRECT only. The hub's deliverable() also hands over broadcasts (to === "all"), and
  // those are FYI — the same distinction the notification policy and T2's block-the-stop rule use.
  const load = () => client.inbox(me)
    .then(r => setMessages((r.messages ?? []).filter(m => m.to === me).reverse()))
    .catch(e => setErr(String(e.message || e)));
  useEffect(() => { load(); client.peers().then(setPeers).catch(() => {}); }, [client, me]);
  useEffect(() => client.streamEvents(ev => { if (ev.type === "message") load(); }), [client, me]);

  const submit = async () => {
    if (!to || !text.trim() || sending) return;
    setSending(true); setErr(null);
    try { await client.send(to, text.trim()); setText(""); load(); }
    catch (e) { setErr(String((e as Error).message || e)); }
    finally { setSending(false); }
  };

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Inbox</h1>
        <p className="tr-page-sub">{me} · {messages.length}</p>
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-8">
        {messages.map(m => {
          return (
            <div key={m.id} className="mb-2 rounded-lg border border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--color-tr-muted)]">
                <span className="truncate text-[var(--color-tr-text)]">{m.from}</span>
                {m.project && (
                  <span className="rounded border border-[var(--color-tr-edge)] px-1.5 py-0.5">{m.project}</span>
                )}
                <span className="ml-auto">{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">{m.text}</div>
              <button onClick={() => setTo(m.from)}
                      className="mt-2 text-[11px] text-[var(--color-tr-muted)] hover:text-[var(--color-tr-doing)]">
                reply to {m.from}
              </button>
            </div>
          );
        })}
        {!messages.length && <div className="p-4 text-sm text-[var(--color-tr-muted)]">Nothing waiting on you. Agent-to-agent traffic lives in each project\u2019s conversation.</div>}
      </div>

      <div className="border-t border-[var(--color-tr-edge)] p-3">
        {err && <div className="mb-2 text-[11px] text-[var(--color-tr-fail)]">{err}</div>}
        <div className="flex gap-2">
          <select value={to} onChange={e => setTo(e.target.value)}
                  className="w-56 shrink-0 rounded border border-[var(--color-tr-edge)] bg-[var(--color-tr-bg)] px-2 py-1.5 text-sm">
            <option value="">to…</option>
            <option value="all">all (broadcast)</option>
            {peers.map(p => <option key={p.session} value={p.session}>{p.session}</option>)}
          </select>
          <input value={text} onChange={e => setText(e.target.value)}
                 onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
                 placeholder="message…"
                 className="min-w-0 flex-1 rounded border border-[var(--color-tr-edge)] bg-[var(--color-tr-bg)] px-3 py-1.5 text-sm" />
          <button onClick={() => void submit()} disabled={!to || !text.trim() || sending}
                  className="shrink-0 rounded bg-[var(--color-tr-doing)] px-3 py-1.5 text-sm text-white disabled:opacity-40">
            {sending ? "…" : "send"}
          </button>
        </div>
      </div>
    </div>
  );
}
