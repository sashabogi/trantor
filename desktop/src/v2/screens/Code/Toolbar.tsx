// The source-control toolbar (#13988): branch pill and picker, the Fetch/Pull/Push Sync menu,
// how long ago git was read, and the Changes / History switch.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, GitBranch, RefreshCw } from "lucide-react";
import { aheadLabel } from "../../../features/code/gitApi";
import { Button } from "../../ui/Button";
import { Seg } from "../../ui/Seg";
import { BranchPicker, type PickerActions } from "./BranchPicker";
import { readAgo, type SeatInfo } from "./model";
import { MainCheckoutMark } from "./parts";
import { checkoutMutationRefusal, scopeFetch, scopePull, scopePush, type GitPullStrategy } from "./scopeGitApi";
import { useShellMode } from "../../shell/shellMode";
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

function SyncMenu({ project, snap, scope, onDone, onError }: {
  project: string; snap: ScopeSnapshot | null; scope: string | null; onDone: () => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"fetch" | "pull" | "push" | null>(null);
  const [diverged, setDiverged] = useState<string | null>(null);
  const ref = useDismiss(open, () => setOpen(false));
  const mode = useShellMode();
  const ahead = snap?.ahead ?? 0;
  const finish = (promise: Promise<unknown>) => {
    promise.then(() => { setOpen(false); setDiverged(null); onDone(); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  const fetch = () => { setBusy("fetch"); finish(scopeFetch(project, scope)); };
  const push = () => { setBusy("push"); finish(scopePush(project, scope)); };
  const pull = (strategy: GitPullStrategy) => {
    setBusy("pull");
    scopePull(project, scope, strategy).then(result => {
      if (result.status === "diverged") { setDiverged(result.reason); return; }
      setOpen(false); setDiverged(null); onDone();
    }).catch(e => onError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
  };
  const pushReason = !snap ? "Reading git" : checkoutMutationRefusal(scope, mode) ?? (ahead === 0 ? "Nothing to push" : busy ? "Sync in progress" : null);
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" icon={<RefreshCw size={12} aria-hidden className={busy ? "animate-spin" : undefined} />}
        disabledReason={busy ? "Sync in progress" : null} onClick={() => setOpen(o => !o)} title="Fetch, pull or push this checkout">
        Sync<ChevronDown size={12} aria-hidden />
      </Button>
      {open && <div role="menu" aria-label="Sync checkout" className="absolute left-0 top-8 z-30 flex w-64 flex-col gap-1 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-1.5 shadow-xl">
        <Button variant="quiet" className="justify-start" disabledReason={busy ? "Sync in progress" : null} onClick={fetch}>Fetch</Button>
        <Button variant="quiet" className="justify-start" disabledReason={!snap ? "Reading git" : busy ? "Sync in progress" : null} onClick={() => pull("ff")}>Pull</Button>
        <Button variant="quiet" icon={<ArrowUp size={12} aria-hidden />} className="justify-start" disabledReason={pushReason} onClick={push}
          title={`Push ${snap?.branch ?? ""} to origin`}>Push ↑{ahead}</Button>
        {diverged && <div role="alert" className="border-t border-[var(--v2-edge)] px-2 pt-2 text-[11.5px] text-[var(--v2-warn)]">
          <p>{diverged}</p><div className="mt-2 flex gap-2"><Button onClick={() => pull("merge")}>Merge</Button><Button onClick={() => pull("rebase")}>Rebase</Button></div>
        </div>}
      </div>}
    </div>
  );
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
      {snap && !snap.seatBacked && (
        <span className="inline-flex items-center text-[11.5px] text-[var(--v2-muted)]" data-testid="checkout-ahead"
          title={snap.upstream ? `Against ${snap.upstream}` : "No upstream: ahead counts commits not on main"}>
          {aheadLabel(snap)}<MainCheckoutMark />
        </span>
      )}
      <SyncMenu project={project} snap={snap} scope={scope} onDone={onMutated} onError={onError} />
      {snap && <span className="text-[11.5px] text-[var(--v2-muted)]" title="When git was last read for this view">read {readAgo(snap.readAt, now)}</span>}
      <span className="flex-1" />
      <Seg label="View" value={view} onChange={onView} options={[{ value: "changes", label: "Changes" }, { value: "history", label: "History" }]} />
    </div>
  );
}
