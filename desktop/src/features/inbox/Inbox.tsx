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
import { Avatar } from "../../shared/Avatar";
import { Composer } from "../../shared/Composer";

const brandOf = (s: string) => s.split(":")[0] ?? s;

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
  useEffect(() => { load(); client.peers().then(setPeers).catch(() => {}); }, [client, me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => client.streamEvents(ev => { if (ev.type === "message") load(); }), [client, me]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <p className="tr-page-sub">Messages that need an answer from you.</p>
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-4">
        {messages.map(m => (
          <div key={m.id} className="tr-card mb-2.5 flex gap-3 p-4">
            <Avatar name={m.from} size={34} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold">{m.from}</span>
                {m.project && <span className="tr-chip shrink-0">{m.project}</span>}
                <span className="ml-auto shrink-0 text-[11px] text-[var(--color-tr-muted)]">
                  {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{m.text}</div>
              <button onClick={() => setTo(m.from)}
                      className="mt-2 text-[12px] text-[var(--color-tr-muted)] hover:text-[var(--color-tr-doing)]">
                Reply to {brandOf(m.from)}
              </button>
            </div>
          </div>
        ))}
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
