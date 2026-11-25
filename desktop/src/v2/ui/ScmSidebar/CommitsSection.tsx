// The Recent commits section of the source control sidebar (#14044): the scope's log, one
// clickable row per commit: short sha, subject, git's own relative when.
import type { GitLogEntry } from "../../../features/code/gitApi";

export function CommitsSection({ log, onOpen }: { log: GitLogEntry[]; onOpen: (sha: string) => void }) {
  if (log.length === 0) return <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">No commits yet.</div>;
  return (
    <div className="flex flex-col pb-1">
      {log.map(c => (
        <button key={c.sha} type="button" data-sha={c.sha} onClick={() => onOpen(c.sha)} title={`Open ${c.subject} in History`}
          className="v2-hover border-0 bg-transparent px-3 py-1.5 text-left">
          <span className="block truncate text-v2-body text-[var(--v2-text)]">{c.subject}</span>
          <span className="v2-mono block truncate text-v2-small text-[var(--v2-muted)]">{c.sha.slice(0, 7)} · {c.when}</span>
        </button>
      ))}
    </div>
  );
}
