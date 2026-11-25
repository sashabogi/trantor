// The Changes tab: the seat's real diff in the classic read-only unified diff view (#13987).
// Loaded lazily by WorkArea because the diff view pulls the Monaco editor with it.
import { UnifiedDiffView } from "../../../features/code/ChangesView";
import type { DiffState } from "./useSeatDiff";

export default function ChangesTab({ state, seatName }: { state: DiffState; seatName: string }) {
  const { diff, error } = state;
  if (!diff) {
    return <div className="p-4 text-v2-base text-[var(--v2-muted)]">{error ?? `Reading ${seatName}'s changes`}</div>;
  }
  if (!diff.files.length) {
    return <div className="p-4 text-v2-base text-[var(--v2-muted)]">{seatName} has no uncommitted changes against {diff.base}.</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="m-0 flex max-h-[30%] list-none flex-col gap-0.5 overflow-auto border-b border-[var(--v2-edge)] p-2 text-v2-body">
        {diff.files.map(f => (
          <li key={f.path} className="flex items-center gap-2 px-1.5 py-0.5">
            <span className="v2-mono min-w-0 flex-1 truncate text-[var(--v2-text-2)]" title={f.path}>{f.path}</span>
            {f.untracked
              ? <span className="text-v2-small text-[var(--v2-muted)]">new</span>
              : <span className="v2-mono text-v2-small"><span className="text-[var(--v2-ok)]">+{f.plus ?? 0}</span> <span className="text-[var(--v2-bad)]">−{f.minus ?? 0}</span></span>}
          </li>
        ))}
      </ul>
      {diff.truncated && <div className="px-3 pt-2 text-v2-small text-[var(--v2-warn)]">The patch was capped at 400KB; this diff is partial.</div>}
      <div className="min-h-[200px] flex-1 p-2"><UnifiedDiffView value={diff.patch} /></div>
    </div>
  );
}
