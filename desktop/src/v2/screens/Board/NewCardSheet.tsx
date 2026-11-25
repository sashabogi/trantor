import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Card, HubClient, Peer } from "../../../shared/api/client";
import { Button } from "../../ui/Button";
import { seatLabel } from "../../ui/identity";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])';

export function NewCardSheet({ client, project, peers, onClose, onCreated }: {
  client: HubClient; project: string; peers: Peer[]; onClose: () => void; onCreated: (card: Card) => void;
}) {
  const [title, setTitle] = useState("");
  const [drill, setDrill] = useState("");
  const [assignee, setAssignee] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => before?.focus();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !drill.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const card = await client.addCard({ project, title: title.trim(), drill: drill.trim(), assignee, difficulty });
      onCreated(card);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const field = "w-full rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-[12.5px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[9vh]" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="New card" onKeyDown={onKeyDown}
        className="w-[480px] max-w-[92vw] rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        <h2 className="m-0 mb-1 text-[16px] font-semibold">New card</h2>
        <p className="m-0 mb-4 text-[11.5px] text-[var(--v2-muted)]">File work in {project}. It starts in To do.</p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-[11.5px] font-medium">Title<input autoFocus required value={title} onChange={e => setTitle(e.target.value)} maxLength={200} className={`${field} mt-1 block`} /></label>
          <label className="text-[11.5px] font-medium">Drill<textarea required value={drill} onChange={e => setDrill(e.target.value)} maxLength={300} rows={4}
            placeholder="What someone runs to accept this card" className={`${field} mt-1 block resize-y`} /><span className="mt-1 block text-right text-[10px] text-[var(--v2-muted)]">{drill.length}/300</span></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11.5px] font-medium">Assignee <span className="font-normal text-[var(--v2-muted)]">(optional)</span>
              <select value={assignee} onChange={e => setAssignee(e.target.value)} className={`${field} mt-1 block`}>
                <option value="">Unassigned</option>
                {peers.map(peer => <option key={peer.session} value={peer.session}>{seatLabel(peer.session)}</option>)}
              </select>
            </label>
            <label className="text-[11.5px] font-medium">Difficulty
              <select value={difficulty} onChange={e => setDifficulty(e.target.value)} className={`${field} mt-1 block`}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </label>
          </div>
          {error && <div role="alert" className="rounded-lg bg-[var(--v2-bad-soft)] px-3 py-2 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
          <div className="mt-1 flex justify-end gap-2">
            <Button onClick={onClose} disabledReason={busy ? "Creating the card" : null}>Cancel</Button>
            <Button type="submit" variant="primary" disabledReason={busy ? "Creating the card" : !title.trim() ? "A title is required" : !drill.trim() ? "A drill is required" : null}>{busy ? "Creating…" : "Create card"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
