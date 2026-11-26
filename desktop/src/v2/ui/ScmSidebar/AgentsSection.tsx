// #14300: the Agents working section of the source control sidebar: one row per active agent or helper
// worktree, with a pulsing dot while it runs, its changed files and unlanded commits, and a click that
// makes that worktree the scope. Read-only: the agent owns its worktree.
import { setOpenIntent } from "../../shell/openIntent";
import { ago } from "../../../shared/time";
import { worktreeCounts, worktreeLabel, worktreeLive, worktreeScope, type AgentWorktree } from "../../screens/Code/useAgentWorktrees";

export type AgentsSectionProps = {
  project: string;
  worktrees: AgentWorktree[];
  /** the scope the sidebar reads right now */
  scope: string | null;
  onPickScope: (scope: string) => void;
};

const FILES_LISTED = 3;

export function AgentsSection({ project, worktrees, scope, onPickScope }: AgentsSectionProps) {
  return (
    <div className="flex flex-col py-1">
      {worktrees.map(w => {
        const id = worktreeScope(w);
        const live = worktreeLive(w);
        const files = live ? (w.files ?? []).slice(0, FILES_LISTED) : [];
        return (
          <div key={w.path} className={`flex flex-col border-0 border-l-2 ${scope === id ? "border-l-[var(--v2-accent)] bg-[var(--v2-raised)]" : "border-l-transparent"}`}>
            <button type="button" data-agent-row={w.path} aria-pressed={scope === id} onClick={() => onPickScope(id)}
              title={`Read ${w.branch ?? w.path}, read-only`}
              className="v2-hover flex items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-v2-body text-[var(--v2-text)]">
              <span data-live={live || undefined} role="img" aria-label={live ? "Working now" : "Idle"}
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${live ? "v2-agent-pulse bg-[var(--v2-ok)]" : "bg-[var(--v2-muted)]"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{worktreeLabel(w)}</span>
                <span className="block truncate text-v2-small text-[var(--v2-muted)]">{worktreeCounts(w)}</span>
              </span>
              <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">{ago(w.last_activity * 1000)}</span>
            </button>
            {files.length > 0 && (
              <div className="flex flex-col pb-1.5 pl-[27px] pr-3">
                {files.map(path => {
                  const cut = path.lastIndexOf("/");
                  return (
                    <button key={path} type="button" data-agent-file={path} title={path}
                      onClick={() => setOpenIntent(project, { kind: "file", path, seat: id })}
                      className="v2-hover flex min-w-0 items-baseline gap-1.5 border-0 bg-transparent p-0 text-left font-mono text-v2-small text-[var(--v2-text-2)]">
                      <span className="shrink-0">{path.slice(cut + 1)}</span>
                      {cut > 0 && <span className="min-w-0 truncate text-[var(--v2-faint)]">{path.slice(0, cut)}</span>}
                    </button>
                  );
                })}
                {w.changed > files.length && <span className="text-v2-small text-[var(--v2-faint)]">+{w.changed - files.length} more</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
