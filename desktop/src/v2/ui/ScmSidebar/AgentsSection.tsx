// #14300: the Agents working group of the source control sidebar: one row per active agent or helper
// worktree, with a pulsing dot while it runs, its changed files and unlanded commits, and a click that
// makes that worktree the scope. Read-only: the agent owns its worktree.
import { setOpenIntent } from "../../shell/openIntent";
import { ago } from "../../../shared/time";
import { worktreeBrief, worktreeLabel, worktreeLive, worktreeScope, type AgentWorktree } from "../../screens/Code/useAgentWorktrees";
import { ListRow } from "../ListRow";

export type AgentsSectionProps = {
  project: string;
  worktrees: AgentWorktree[];
  /** the scope the sidebar reads right now */
  scope: string | null;
  onPickScope: (scope: string) => void;
};

const FILES_LISTED = 3;
const FILE_INDENT = 22;

export function AgentsSection({ project, worktrees, scope, onPickScope }: AgentsSectionProps) {
  return (
    <div className="flex flex-col">
      {worktrees.map(w => {
        const id = worktreeScope(w);
        const live = worktreeLive(w);
        const files = live ? (w.files ?? []).slice(0, FILES_LISTED) : [];
        return (
          <div key={w.path} className="flex flex-col">
            <ListRow selected={scope === id} name={worktreeLabel(w)} meta={worktreeBrief(w)}
              leading={<span data-live={live || undefined} role="img" aria-label={live ? "Working now" : "Idle"}
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${live ? "v2-agent-pulse bg-[var(--v2-accent)]" : "bg-[var(--v2-faint)]"}`} />}
              trailing={<span className="shrink-0 text-v2-small text-[var(--v2-faint)]">{ago(w.last_activity * 1000)}</span>}
              main={{ "data-agent-row": w.path, "aria-pressed": scope === id, onClick: () => onPickScope(id), title: `Read ${w.branch ?? w.path}, read-only` }} />
            {files.map(path => {
              const cut = path.lastIndexOf("/");
              return (
                <ListRow key={path} indent={FILE_INDENT} className="font-mono text-v2-small"
                  name={<span className="text-[var(--v2-text-2)]">{path.slice(cut + 1)}</span>} meta={cut > 0 ? path.slice(0, cut) : undefined}
                  main={{ "data-agent-file": path, title: path, onClick: () => setOpenIntent(project, { kind: "file", path, seat: id }) }} />
              );
            })}
            {files.length > 0 && w.changed > files.length && (
              <ListRow indent={FILE_INDENT} className="text-v2-small" name={<span className="text-[var(--v2-faint)]">+{w.changed - files.length} more</span>} />
            )}
          </div>
        );
      })}
    </div>
  );
}
