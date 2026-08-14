// PROPOSALS — the human half of agent-proposed permissions, in ONE module on purpose.
//
// The roll-up lesson (monitoring doctrine): the moment two surfaces render the same queue from
// separate code, they disagree about the same data. Home and Overseer both show this queue, and
// the sidebar badges its count — all three read through here.
//
// An undecided proposal is a BLOCKED AGENT: it filed its bound and moved on, but whatever needed
// the permission stays undone until the human rules. So pending proposals are surfaced (Home,
// Overseer, badge, native notification on filing) rather than waiting to be found — while an
// EMPTY queue renders nothing at all, because "no decisions waiting" is not news.
import { useEffect, useState } from "react";
import type { HubClient, Proposal } from "./api/client";

/** Live pending proposals: stream-driven with a slow poll as the fallback. Shared by every surface. */
export function usePendingProposals(client: HubClient | null): Proposal[] {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = () => client.proposals({ status: "pending" })
      .then(r => { if (alive) setProposals(r.proposals ?? []); })
      .catch(() => { /* an older hub has no /proposals — every surface simply stays empty */ });
    load();
    const t = setInterval(load, 60_000);
    const off = client.streamEvents(ev => { if (ev.type?.startsWith("proposal.")) load(); });
    return () => { alive = false; clearInterval(t); off(); };
  }, [client]);
  return proposals;
}

function agoS(ts: number) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The decision queue itself. Renders NOTHING when no proposals are pending — callers can mount it
 * unconditionally. Approve is one click; Deny demands a note, because the note is what the agent
 * gets quoted back if it ever re-asks (the hub's denial memory).
 */
export function ProposalsSection({ client }: { client: HubClient }) {
  const proposals = usePendingProposals(client);
  const [denying, setDenying] = useState<number | null>(null);
  const [denyNote, setDenyNote] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  // optimistic removal — the stream's proposal.decided reload confirms it moments later
  const [settled, setSettled] = useState<Set<number>>(new Set());

  const open = proposals.filter(p => !settled.has(p.id));
  if (!open.length) return null;

  const decide = (id: number, verdict: "approved" | "denied", note?: string) => {
    setBusy(id);
    client.decideProposal(id, verdict, note)
      .then(() => setSettled(s => new Set(s).add(id)))
      .catch(() => { /* the row stays — a failed decide must not vanish the ask */ })
      .finally(() => { setBusy(null); setDenying(null); setDenyNote(""); });
  };

  return (
    <section className="min-w-0">
      <h2 className="tr-sec-title">Proposals</h2>
      <p className="tr-sec-sub">
        {open.length} standing permission{open.length > 1 ? "s" : ""} proposed by agents — each states its bound; you are the only approver.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {open.map(p => (
          <div key={p.id} className="tr-card p-3.5" style={{ borderStyle: "dashed" }}>
            <div className="text-[13px] leading-snug">{p.scope}</div>
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-tr-muted)]">
              <span className="text-right opacity-70">when</span><span className="min-w-0 break-words">{p.condition}</span>
              <span className="text-right opacity-70">not covered</span><span className="min-w-0 break-words">{p.exclusions}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="tr-chip shrink-0">{p.project}</span>
              <span className="tr-chip tr-mono shrink-0">{p.session}</span>
              <span className="text-[11px] text-[var(--color-tr-muted)]">{agoS(p.ts)}</span>
              <span className="flex-1" />
              {denying === p.id ? (
                <>
                  <input autoFocus value={denyNote} onChange={e => setDenyNote(e.target.value)}
                         onKeyDown={e => { if (e.key === "Enter" && denyNote.trim()) decide(p.id, "denied", denyNote.trim()); if (e.key === "Escape") { setDenying(null); setDenyNote(""); } }}
                         placeholder="Why not? The agent remembers this…" className="tr-input w-64 text-[12px]" />
                  <button disabled={!denyNote.trim() || busy === p.id}
                          onClick={() => decide(p.id, "denied", denyNote.trim())}
                          className="tr-chip shrink-0 px-2.5 py-1 text-[var(--color-tr-fail)] disabled:opacity-40">
                    Deny
                  </button>
                </>
              ) : (
                <>
                  <button disabled={busy === p.id} onClick={() => decide(p.id, "approved")}
                          className="tr-chip shrink-0 px-2.5 py-1 text-[var(--color-tr-ok)] disabled:opacity-40">
                    Approve
                  </button>
                  <button disabled={busy === p.id} onClick={() => { setDenying(p.id); setDenyNote(""); }}
                          className="tr-chip shrink-0 px-2.5 py-1 text-[var(--color-tr-muted)] disabled:opacity-40">
                    Deny…
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
