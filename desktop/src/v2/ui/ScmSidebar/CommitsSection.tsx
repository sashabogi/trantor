// The Recent commits section of the source control sidebar (#14044): the scope's log, one
// clickable row per commit: short sha, subject, git's own relative when.
// #14300: a commit that arrives on a later poll glows briefly, so work landing on the checkout is noticed.
import { useEffect, useRef, useState } from "react";
import type { GitLogEntry } from "../../../features/code/gitApi";

const HIGHLIGHT_MS = 2_500;

function useNewCommits(log: GitLogEntry[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const shas = log.map(c => c.sha);
    const before = seen.current;
    seen.current = new Set(shas);
    if (!before) return;
    const added = shas.filter(sha => !before.has(sha));
    if (added.length === 0) return;
    setFresh(new Set(added));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFresh(new Set()), HIGHLIGHT_MS);
  }, [log]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return fresh;
}

export function CommitsSection({ log, onOpen }: { log: GitLogEntry[]; onOpen: (sha: string) => void }) {
  const fresh = useNewCommits(log);
  if (log.length === 0) return <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">No commits yet.</div>;
  return (
    <div className="flex flex-col pb-1">
      {log.map(c => (
        <button key={c.sha} type="button" data-sha={c.sha} data-new={fresh.has(c.sha) || undefined} onClick={() => onOpen(c.sha)} title={`Open ${c.subject} in History`}
          className={`v2-hover border-0 px-3 py-1.5 text-left ${fresh.has(c.sha) ? "v2-commit-new" : "bg-transparent"}`}>
          <span className="block truncate text-v2-body text-[var(--v2-text)]">{c.subject}</span>
          <span className="v2-mono block truncate text-v2-small text-[var(--v2-muted)]">{c.sha.slice(0, 7)} · {c.when}</span>
        </button>
      ))}
    </div>
  );
}
