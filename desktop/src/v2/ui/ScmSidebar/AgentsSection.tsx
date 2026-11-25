// #14300: the Agents working section of the source control sidebar: one row per active agent or helper
// worktree, with a pulsing dot while it runs, its changed files and unlanded commits, and a click that
// makes that worktree the scope. Read-only: the agent owns its worktree.
import { ago } from "../../../shared/time";
import { worktreeCounts, worktreeLabel, worktreeLive, worktreeScope, type AgentWorktree } from "../../screens/Code/useAgentWorktrees";

export type AgentsSectionProps = {
  worktrees: AgentWorktree[];
  /** the scope the sidebar reads right now */
  scope: string | null;
  onPickScope: (scope: string) => void;
};

export function AgentsSection({ worktrees, scope, onPickScope }: AgentsSectionProps) {
  return (
    <div className="flex flex-col py-1">
      {worktrees.map(w => {
        const id = worktreeScope(w);
        const live = worktreeLive(w);
        return (
          <button key={w.path} type="button" data-agent-row={w.path} aria-pressed={scope === id} onClick={() => onPickScope(id)}
            title={`Read ${w.branch ?? w.path}, read-only`}
            className={`v2-hover flex items-center gap-2 border-0 border-l-2 bg-transparent px-3 py-1.5 text-left text-v2-body text-[var(--v2-text)] ${scope === id ? "border-l-[var(--v2-accent)] bg-[var(--v2-raised)]" : "border-l-transparent"}`}>
            <span data-live={live || undefined} role="img" aria-label={live ? "Working now" : "Idle"}
              className={`h-[7px] w-[7px] shrink-0 rounded-full ${live ? "v2-agent-pulse bg-[var(--v2-ok)]" : "bg-[var(--v2-muted)]"}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{worktreeLabel(w)}</span>
              <span className="block truncate text-v2-small text-[var(--v2-muted)]">{worktreeCounts(w)}</span>
            </span>
            <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">{ago(w.last_activity * 1000)}</span>
          </button>
        );
      })}
    </div>
  );
}
