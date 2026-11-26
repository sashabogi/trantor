// The Branches and seats section of the source control sidebar (#14047): the main checkout first,
// then one row per seat from screens/Code/useSeats with its branch, unlanded count and presence.
// A row click moves the scope the sidebar reads; a seat with no worktree is disabled with the
// reason in its title. The main checkout's branch comes through the same git_panel bridge.
import type { SeatInfo } from "../../screens/Code/model";
import { useScopeGit } from "../../screens/Code/useScopeGit";
import { Avatar } from "../Avatar";
import { seatLabel } from "../identity";
import { ListRow } from "../ListRow";

/** The main checkout's branch, from the shared scope read (#14344); null until the read answers. */
function useMainBranch(project: string): string | null {
  const { state } = useScopeGit(project, null);
  return state.kind === "ok" ? state.snap.branch : null;
}

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
    <div className="flex flex-col">
      <ListRow selected={p.scope === null} name={<span className="v2-mono">{mainBranch ?? "reading…"}</span>}
        trailing={<span className="shrink-0 text-v2-small text-[var(--v2-faint)]">main checkout</span>}
        main={{ "data-scope-row": "main", "aria-pressed": p.scope === null, onClick: () => p.onPickScope(null),
          title: mainBranch ? `The project checkout on ${mainBranch}` : "The project checkout" }} />
      {p.seats.map(s => (
        <ListRow key={s.seat} selected={p.scope === s.seat} name={seatLabel(s.seat)} meta={<span className="v2-mono">{s.branch ?? "no branch read"}</span>}
          leading={<Avatar name={s.seat} size={16} presence={s.presence} />}
          trailing={s.ahead ? <span className="v2-mono shrink-0 text-v2-small text-[var(--v2-muted)]">↑{s.ahead}</span> : undefined}
          main={{ "data-scope-row": s.seat, disabled: !s.hasWorktree, "aria-pressed": p.scope === s.seat, onClick: () => p.onPickScope(s.seat),
            title: s.hasWorktree ? `Read ${s.branch ?? s.seat}${s.ahead ? ` · ${s.ahead} unlanded` : ""}` : "This session has no worktree to read" }} />
      ))}
      {p.seats.length === 0 && <div className="px-3 py-1 text-v2-body text-[var(--v2-muted)]">No seat sessions for this project.</div>}
    </div>
  );
}
