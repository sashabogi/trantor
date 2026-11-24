// The source-control toolbar (#13988): branch pill and picker, Fetch, Push with its ahead count,
// how long ago git was read, and the Changes / History switch.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, GitBranch } from "lucide-react";
import { gitPush } from "../../../features/code/gitApi";
import { Button } from "../../ui/Button";
import { Seg } from "../../ui/Seg";
import { BranchPicker, type PickerActions } from "./BranchPicker";
import { readAgo, type SeatInfo } from "./model";
import type { ScopeSnapshot } from "./useScopeGit";

export type ScmView = "changes" | "history";

function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, onClose]);
  return ref;
}

function PushButton({ project, snap, onDone, onError }: { project: string; snap: ScopeSnapshot | null; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const ahead = snap?.ahead ?? 0;
  const reason = !snap ? "Reading git" : !snap.seatBacked ? "Push acts on a seat's worktree. Pick a seat in the branch picker." : ahead === 0 ? "Nothing to push" : busy ? "Pushing" : null;
  const push = () => {
    if (!snap?.scope) return;
    setBusy(true);
    gitPush(project, snap.scope).then(onDone).catch(e => onError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  return <Button variant="ghost" icon={<ArrowUp size={12} aria-hidden />} disabledReason={reason} onClick={push} title={`Push ${snap?.branch ?? ""} to origin`}>Push ↑{ahead}</Button>;
}

export function Toolbar({ project, snap, seats, scope, acts, view, onView, onMutated, onError }: {
  project: string; snap: ScopeSnapshot | null; seats: SeatInfo[]; scope: string | null; acts: PickerActions;
  view: ScmView; onView: (v: ScmView) => void; onMutated: () => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(iv); }, []);
  const name = snap?.branch ?? (scope ? scope : "project checkout");
  const tone = snap?.ahead ? "var(--v2-accent)" : "var(--v2-ok)";
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--v2-edge)] px-3 py-2">
      <div ref={ref} className="relative">
        <button type="button" aria-haspopup="dialog" aria-expanded={open} title="Switch branch" onClick={() => setOpen(o => !o)}
          className="v2-hover inline-flex items-center gap-1.5 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-[5px] text-[12px] text-[var(--v2-text)]">
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: tone }} /><GitBranch size={12} aria-hidden />
          <span className="v2-mono">{name}</span><ChevronDown size={12} aria-hidden />
        </button>
        {open && <BranchPicker seats={seats} scope={scope} acts={acts} onClose={() => setOpen(false)} />}
      </div>
      <Button variant="ghost" disabledReason="Fetch needs a git fetch command. Not wired yet.">Fetch</Button>
      <PushButton project={project} snap={snap} onDone={onMutated} onError={onError} />
      {snap && <span className="text-[11.5px] text-[var(--v2-muted)]" title="When git was last read for this view">read {readAgo(snap.readAt, now)}</span>}
      <span className="flex-1" />
      <Seg label="View" value={view} onChange={onView} options={[{ value: "changes", label: "Changes" }, { value: "history", label: "History" }]} />
    </div>
  );
}
