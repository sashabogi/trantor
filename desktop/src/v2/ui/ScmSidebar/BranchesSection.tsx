// The Branches and seats section of the source control sidebar (#14047): the main checkout first,
// then one row per seat from screens/Code/useSeats with its branch, unlanded count and presence.
// A row click moves the scope the sidebar reads; a seat with no worktree is disabled with the
// reason in its title. The main checkout's branch comes through the same git_panel bridge.
import { useEffect, useState } from "react";
import type { SeatInfo } from "../../screens/Code/model";
import { scopePanel } from "../../screens/Code/scopeGitApi";
import { Avatar } from "../Avatar";
import { seatLabel } from "../identity";

/** The main checkout's branch, read once per project; null until git answers. */
function useMainBranch(project: string): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    scopePanel(project, null, 1)
      .then(p => { if (alive) setBranch(p.branch || null); })
      .catch(() => { if (alive) setBranch(null); });
    return () => { alive = false; };
  }, [project]);
  return branch;
}

const rowBase = "v2-hover flex items-center gap-2 border-0 border-l-2 bg-transparent px-3 py-1.5 text-left text-[12px] text-[var(--v2-text)] disabled:opacity-50";

export type BranchesSectionProps = {
  project: string;
  /** the seat whose worktree the sidebar reads, or null for the project checkout */
  scope: string | null;
  seats: SeatInfo[];
  onPickScope: (seat: string | null) => void;
};

export function BranchesSection(p: BranchesSectionProps) {
  const mainBranch = useMainBranch(p.project);
  return (
    <div className="flex flex-col py-1">
      <button type="button" data-scope-row="main" aria-pressed={p.scope === null} onClick={() => p.onPickScope(null)}
        title={mainBranch ? `The project checkout on ${mainBranch}` : "The project checkout"}
        className={`${rowBase} ${p.scope === null ? "border-l-[var(--v2-accent)] bg-[var(--v2-raised)]" : "border-l-transparent"}`}>
        <span className="v2-mono min-w-0 flex-1 truncate">{mainBranch ?? "reading…"}</span>
        <span className="shrink-0 text-[10.5px] text-[var(--v2-muted)]">main checkout</span>
      </button>
      {p.seats.map(s => (
        <button key={s.seat} type="button" data-scope-row={s.seat} disabled={!s.hasWorktree} aria-pressed={p.scope === s.seat}
          onClick={() => p.onPickScope(s.seat)}
          title={s.hasWorktree
            ? `Read ${s.branch ?? s.seat}${s.ahead ? ` · ${s.ahead} unlanded` : ""}`
            : "This session has no worktree to read"}
          className={`${rowBase} ${p.scope === s.seat ? "border-l-[var(--v2-accent)] bg-[var(--v2-raised)]" : "border-l-transparent"}`}>
          <Avatar name={s.seat} size={20} presence={s.presence} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{seatLabel(s.seat)}</span>
            <span className="v2-mono block truncate text-[10.5px] text-[var(--v2-muted)]">{s.branch ?? "no branch read"}</span>
          </span>
          {s.ahead ? <span className="v2-mono shrink-0 text-[10.5px] text-[var(--v2-muted)]">↑{s.ahead}</span> : null}
        </button>
      ))}
      {p.seats.length === 0 && <div className="px-3 py-1 text-[11.5px] text-[var(--v2-muted)]">No seat sessions for this project.</div>}
    </div>
  );
}
