// The merge conflict view (#13988), shown when git lists unmerged paths. Taking a side writes the
// file and stages it through the classic write and stage commands. Continue and Abort have no
// command yet, so they are disabled with the reason.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { readFile, writePlain } from "../../../features/code/fileApi";
import { conflictPaths, gitStage } from "../../../features/code/gitApi";
import { Button } from "../../ui/Button";
import { countConflicts, parseConflicts, resolveChunks, type Chunk, type Choice } from "./conflicts";
import { NotWiredBlock, PathLabel } from "./parts";
import type { ScopeSnapshot } from "./useScopeGit";

const message = (e: Error | string) => (e instanceof Error ? e.message : String(e));

async function resolveFile(project: string, scope: string, path: string, picks: ReadonlyMap<number, Choice>): Promise<void> {
  const body = await readFile(project, path, scope);
  if (body.truncated) throw new Error("The file is larger than the 512 KB read cap, so it cannot be resolved here.");
  const text = resolveChunks(parseConflicts(body.text), picks);
  await writePlain(project, path, scope, text);
  await gitStage(project, scope, [path], false);
}

function allPicks(count: number, pick: Choice): Map<number, Choice> {
  return new Map(Array.from({ length: count }, (_, i) => [i, pick]));
}

function Side({ title, label, text, onAccept }: { title: string; label: string; text: string; onAccept: () => void }) {
  return (
    <div className="min-w-0 flex-1 basis-1/2 overflow-hidden rounded-lg border border-[var(--v2-edge)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-3 py-1.5 text-[11.5px]">
        <span className="font-semibold text-[var(--v2-text)]">{title}</span><span className="v2-mono min-w-0 flex-1 truncate text-[var(--v2-muted)]">{label}</span>
        <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" onClick={onAccept}>Accept this</Button>
      </div>
      <pre className="v2-mono m-0 overflow-x-auto px-3 py-2 text-[12px] leading-[19px] text-[var(--v2-text-2)]">{text || " "}</pre>
    </div>
  );
}

function ConflictEditor({ project, scope, path, onResolved, onError }: { project: string; scope: string; path: string; onResolved: () => void; onError: (m: string) => void }) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [picks, setPicks] = useState<Map<number, Choice>>(new Map());
  useEffect(() => {
    let alive = true;
    setChunks(null);
    setPicks(new Map());
    readFile(project, path, scope).then(b => { if (alive) setChunks(parseConflicts(b.text)); }).catch(e => { if (alive) onError(message(e)); });
    return () => { alive = false; };
  }, [project, scope, path, onError]);
  const total = useMemo(() => (chunks ? countConflicts(chunks) : 0), [chunks]);
  if (!chunks) return <div className="p-4 text-[12.5px] text-[var(--v2-muted)]">Reading {path}</div>;
  const left = total - picks.size;
  const pick = (i: number, p: Choice) => setPicks(m => new Map(m).set(i, p));
  let n = -1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-4 py-2 text-[12px]">
        <span className="v2-mono flex-1 truncate text-[var(--v2-text)]">{path}</span>
        <span className="text-[var(--v2-muted)]">{total} {total === 1 ? "conflict" : "conflicts"} · {left} left</span>
        <Button variant="primary" disabledReason={left > 0 ? "Resolve the remaining conflicts first" : null}
          onClick={() => resolveFile(project, scope, path, picks).then(onResolved).catch(e => onError(message(e)))}>Mark resolved</Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {total === 0 && <NotWiredBlock title="No conflict markers in this file" line="Git lists it as unmerged but the text has no markers (for example a delete against an edit). Resolve it in a terminal." />}
        {chunks.map(c => {
          if (c.kind === "text") return null;
          n++;
          const i = n;
          const chosen = picks.get(i);
          return (
            <section key={i} aria-label={`Conflict ${i + 1} of ${total}`} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[11.5px] text-[var(--v2-muted)]">
                Conflict {i + 1} of {total}{chosen && <span className="text-[var(--v2-ok)]">· resolved: {chosen === "both" ? "both" : chosen === "theirs" ? "incoming" : "current"}</span>}
                <span className="flex-1" /><Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" onClick={() => pick(i, "both")}>Accept both</Button>
              </div>
              <div className="flex gap-3">
                <Side title="Incoming" label={c.theirsLabel} text={c.theirs} onAccept={() => pick(i, "theirs")} />
                <Side title="Current" label={c.oursLabel} text={c.ours} onAccept={() => pick(i, "ours")} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function ConflictView({ project, snap, path, onPick, onResolved }: { project: string; snap: ScopeSnapshot; path: string | null; onPick: (p: string) => void; onResolved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const paths = conflictPaths(snap.status);
  const scope = snap.scope;
  const active = path && paths.includes(path) ? path : paths[0] ?? null;
  if (!scope) return <div className="p-4"><NotWiredBlock title="Conflicts are resolved in a seat's worktree" line="Writing and staging a resolved file needs a seat scope. Choice a seat in the branch picker." /></div>;
  const take = (p: string, pick: Choice) => {
    readFile(project, p, scope).then(b => resolveFile(project, scope, p, allPicks(countConflicts(parseConflicts(b.text)), pick)))
      .then(onResolved).catch(e => setError(message(e)));
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Conflicted files" className="flex w-[300px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--v2-edge)] p-3">
        <div className="rounded-[10px] border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] p-3 text-[12px] text-[var(--v2-text-2)]">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-[var(--v2-warn)]"><AlertTriangle size={13} aria-hidden />Merge paused</div>
          Git lists {paths.length} {paths.length === 1 ? "file" : "files"} as unmerged on {snap.branch ?? scope}. Whether it is a merge or a rebase is not readable yet.
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button disabledReason={paths.length > 0 ? `${paths.length} files still have conflicts` : "Continue needs a git command. Not wired yet."}>Continue</Button>
            <Button disabledReason="Abort needs a git command and asks first. Not wired yet.">Abort…</Button>
          </div>
        </div>
        {error && <div role="alert" className="text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
        {paths.length === 0 && <div className="text-[12px] text-[var(--v2-ok)]">No unmerged files. Nothing is waiting on you.</div>}
        {paths.map(p => (
          <div key={p} className={`rounded-lg border p-2 ${p === active ? "border-[var(--v2-accent)]" : "border-[var(--v2-edge)]"}`}>
            <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-2 border-0 bg-transparent p-0 text-left text-[12px]"><span className="text-[var(--v2-bad)]">!</span><PathLabel path={p} /></button>
            <div className="mt-1.5 flex gap-1">
              <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" title="Keep the current side of every conflict in this file" onClick={() => take(p, "ours")}>Take current</Button>
              <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" title="Keep the incoming side of every conflict in this file" onClick={() => take(p, "theirs")}>Take incoming</Button>
            </div>
          </div>
        ))}
      </aside>
      {active ? <ConflictEditor key={active} project={project} scope={scope} path={active} onResolved={onResolved} onError={setError} /> : <div className="flex-1" />}
    </div>
  );
}
