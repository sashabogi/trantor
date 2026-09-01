// The Review lens's git rail, now the SCM panel (#5791). Review showed the seat's diff but left
// every git action to a terminal; this panel is branch, commit box on top, then STAGED / CHANGES
// as collapsible sections with counts and bulk actions — VS Code's source-control shape — plus
// push and the recent log, all against the SELECTED seat's worktree through the git_* commands in
// src-tauri. Every mutation is refused seat-side while the seat is working (the same guard
// file_write_plain applies) — the refusal comes back verbatim and lands in the status line, never a
// dialog. There is deliberately NO discard here: deleting a seat's uncommitted work is not a
// review action.
import { useCallback, useEffect, useState } from "react";
import {
  aheadLabel,
  bucketStatus,
  isUnmerged,
  lineCountFor,
  gitCommit,
  gitPanel,
  gitPush,
  gitStage,
  scmSections,
  stageableChanges,
  type GitPanelSnapshot,
} from "./gitApi";

/** The +N/−N chip, colored from the git decoration tokens the tree rows share
 *  (styles.css --git-decoration-*; Orca's diff-line-counts.tsx is the shape). Renders nothing
 *  when git counted nothing — a zero would claim a measurement nobody made. */
function LineCountChip({ counts, path }: { counts: GitPanelSnapshot["counts"]; path: string }) {
  const n = lineCountFor(counts, path);
  if (!n) return null;
  return (
    <span className="tr-mono shrink-0 text-[10px] tabular-nums">
      <span style={{ color: "var(--git-decoration-added)" }}>+{n.plus}</span>{" "}
      <span style={{ color: "var(--git-decoration-deleted)" }}>−{n.minus}</span>
    </span>
  );
}

/** "Overseer.tsx  features/overseer" — the name leads and the directory follows dimmed, the way
 *  the SourceControl artboard (and Orca) lay a changed row out. A path truncated from the right
 *  in a 300px pane showed "desktop/src/feature…" for every row: the one part nobody needed. */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  const dir = cut === -1 ? "" : path.slice(0, cut);
  return (
    <>
      <span className="text-tr-text">{name}</span>
      {dir && <span className="ml-1.5 text-[10.5px] text-tr-muted/60">{dir}</span>}
    </>
  );
}

export function GitPanel({ project, seat, onChanged, onOpenFile }: {
  project: string; seat: string; onChanged?: () => void; onOpenFile?: (path: string) => void;
}) {
  const [snap, setSnap] = useState<GitPanelSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "fail"; text: string } | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);

  const pull = useCallback(() => {
    gitPanel(project, seat)
      .then(s => { setSnap(s); setErr(null); })
      .catch(e => setErr(String(e)));
  }, [project, seat]);

  useEffect(() => {
    setSnap(null);
    setErr(null);
    setStatus(null);
    setMsg("");
    pull();
    const iv = setInterval(pull, 12_000);
    return () => clearInterval(iv);
  }, [pull]);

  // () => Promise<void>: callers' richer promise results are deliberately discarded here — the
  // panel re-pulls the snapshot after every action, so the pull is the truth, not the return.
  const act = async (run: () => Promise<void>, okText: string) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await run();
      setStatus({ kind: "ok", text: okText });
      pull();
      onChanged?.();
    } catch (e) {
      setStatus({ kind: "fail", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const buckets = snap ? bucketStatus(snap.status) : null;
  const sections = snap ? scmSections(snap.status) : null;
  const commitDisabled = busy || !sections || sections.staged.length === 0 || !msg.trim();
  const pushDisabled = busy || !snap || !snap.branch || snap.ahead === 0;

  // Bulk actions send every pathspec in ONE git call (batched against E2BIG per
  // RESEARCH-orca-files §3), not one subprocess per file. Conflicted paths are excluded from the
  // batch with the same predicate the row button uses — staging one erases the conflict record.
  const stageAll = () => {
    if (snap && stageableChanges(snap.status).length > 0) {
      const paths = stageableChanges(snap.status);
      const n = paths.length;
      void act(() => gitStage(project, seat, paths, false), `staged ${n} file${n === 1 ? "" : "s"}`);
    }
  };
  const unstageAll = () => {
    if (snap && buckets) {
      // Conflicted rows ride the staged list too (X = U); resetting them would degrade git's
      // conflict record the same way staging would. Same predicate as the row button.
      const paths = buckets.staged.filter(e => !isUnmerged(e)).map(e => e.path);
      if (paths.length === 0) return;
      const n = paths.length;
      void act(() => gitStage(project, seat, paths, true), `unstaged ${n} file${n === 1 ? "" : "s"}`);
    }
  };

  const stageOne = (path: string) => { void act(() => gitStage(project, seat, [path]), `staged ${path}`); };
  const unstageOne = (path: string) => { void act(() => gitStage(project, seat, [path], true), `unstaged ${path}`); };

  return (
    <div className="tr-card flex h-full min-h-0 flex-col px-3 py-2.5">
      {/* header: branch + position */}
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="text-[13px] font-semibold">git</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px] text-tr-muted">
          {err ? "—" : snap ? snap.branch || "detached" : "…"}
        </span>
        {snap && !err && (
          <span className="tr-mono shrink-0 text-[11px] text-tr-muted" title={snap.upstream ?? "no upstream — ahead counts unlanded work against main"}>
            {aheadLabel(snap)}
          </span>
        )}
      </div>

      {err && (
        <div className="tr-card-ghost my-1 px-3 py-3 text-[12px] leading-relaxed">
          git state unreadable: <span className="tr-mono">{err}</span>
        </div>
      )}

      {/* commit box — top, as VS Code does */}
      {snap && !err && (
        <div className="flex items-center gap-1.5 pb-2">
          <input
            value={msg}
            onChange={e => setMsg(e.target.value)}
            placeholder="Commit message…"
            className="tr-mono min-w-0 flex-1 rounded-md border border-tr-edge bg-transparent px-2 py-1.5 text-[11.5px] outline-none placeholder:text-tr-muted/60 focus:border-tr-doing/50"
          />
          <button
            onClick={() => {
              const text = msg.trim();
              if (!text) return;
              void act(async () => { await gitCommit(project, seat, text); setMsg(""); }, "committed");
            }}
            disabled={commitDisabled}
            className="shrink-0 rounded-lg bg-tr-doing/20 px-2.5 py-1.5 text-[11.5px] font-medium text-tr-doing disabled:opacity-40"
          >
            Commit
          </button>
        </div>
      )}

      {buckets && snap && !err && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          {/* STAGED — collapsible, hover unstage per file, unstage-all on the header */}
          <section>
            <div className="flex items-center gap-1 px-1 py-1">
              <button
                type="button"
                onClick={() => setStagedOpen(o => !o)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="w-3 shrink-0 text-[10px] text-tr-muted">{stagedOpen ? "▾" : "▸"}</span>
                <span className="truncate text-[11px] font-medium text-tr-muted">Staged ({buckets.staged.length})</span>
              </button>
              {buckets.staged.length > 0 && (
                <button
                  type="button"
                  onClick={unstageAll}
                  disabled={busy}
                  title={`unstage all ${buckets.staged.length} file${buckets.staged.length === 1 ? "" : "s"}`}
                  className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                >−</button>
              )}
            </div>
            {stagedOpen && buckets.staged.length === 0 && (
              <div className="px-1 py-0.5 text-[11.5px] text-tr-muted/70">Nothing staged.</div>
            )}
            {stagedOpen && buckets.staged.map(e => {
              const conflict = isUnmerged(e);
              return (
                <div key={`s-${e.path}`} className="group flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(e.path)}
                    className="tr-mono min-w-0 flex-1 truncate text-left text-[11.5px]"
                    title={`${e.x}${e.y} ${e.path} — open diff`}
                  ><PathLabel path={e.path} /></button>
                  <LineCountChip counts={snap?.counts ?? []} path={e.path} />
                  {conflict && (
                    <span className="tr-chip shrink-0" title="unmerged — git needs a human before anything touches this path">conflict</span>
                  )}
                  <button
                    type="button"
                    onClick={() => unstageOne(e.path)}
                    disabled={busy || conflict}
                    title={conflict
                      ? "unavailable on a conflicted path — resolve the conflict first"
                      : "unstage"}
                    className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                  >−</button>
                </div>
              );
            })}
          </section>

          {/* CHANGES (unstaged + untracked) — collapsible, hover stage per file, stage-all on header */}
          <section>
            <div className="flex items-center gap-1 px-1 py-1">
              <button
                type="button"
                onClick={() => setChangesOpen(o => !o)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="w-3 shrink-0 text-[10px] text-tr-muted">{changesOpen ? "▾" : "▸"}</span>
                <span className="truncate text-[11px] font-medium text-tr-muted">
                  Changes ({buckets.unstaged.length + buckets.untracked.length})
                </span>
              </button>
              {(buckets.unstaged.length > 0 || buckets.untracked.length > 0) && (
                <button
                  type="button"
                  onClick={stageAll}
                  disabled={busy}
                  title={`stage all ${sections?.changes.length ?? 0} file${(sections?.changes.length ?? 0) === 1 ? "" : "s"}`}
                  className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                >+</button>
              )}
            </div>
            {changesOpen && buckets.unstaged.length === 0 && buckets.untracked.length === 0 && (
              <div className="px-1 py-0.5 text-[11.5px] text-tr-muted/70">No changes.</div>
            )}
            {changesOpen && buckets.unstaged.map(e => {
              const conflict = isUnmerged(e);
              return (
                <div key={`u-${e.path}`} className="group flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(e.path)}
                    className="tr-mono min-w-0 flex-1 truncate text-left text-[11.5px]"
                    title={`${e.x}${e.y} ${e.path} — open diff`}
                  ><PathLabel path={e.path} /></button>
                  <LineCountChip counts={snap?.counts ?? []} path={e.path} />
                  {conflict && (
                    <span className="tr-chip shrink-0" title="unmerged — staging would erase git's conflict record before review">conflict</span>
                  )}
                  <button
                    type="button"
                    onClick={() => stageOne(e.path)}
                    disabled={busy || conflict}
                    title={conflict
                      ? "staging would erase git's conflict record — resolve the conflict first"
                      : "stage"}
                    className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                  >+</button>
                </div>
              );
            })}
            {changesOpen && buckets.untracked.map(p => (
              <div key={`n-${p}`} className="group flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                <button
                  type="button"
                  onClick={() => onOpenFile?.(p)}
                  className="tr-mono min-w-0 flex-1 truncate text-left text-[11.5px]"
                  title={`untracked ${p} — open diff`}
                ><PathLabel path={p} /></button>
                <span className="tr-chip shrink-0">new</span>
                <button
                  type="button"
                  onClick={() => stageOne(p)}
                  disabled={busy}
                  title="stage"
                  className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                >+</button>
              </div>
            ))}
          </section>

          {/* push */}
          <section>
            <button
              onClick={() => { void act(async () => { await gitPush(project, seat); }, "pushed"); }}
              disabled={pushDisabled}
              title={!snap?.branch ? "detached HEAD" : snap.ahead === 0 ? "nothing to push" : `push ${snap.branch} to origin`}
              className="w-full rounded-lg border border-tr-edge px-2.5 py-1.5 text-[11.5px] font-medium text-tr-text disabled:opacity-40"
            >
              Push {snap?.branch ? snap.branch : ""} to origin
            </button>
          </section>

          {/* status line — git's own words, verbatim */}
          {status && (
            <div className={`px-1 text-[11.5px] ${status.kind === "ok" ? "text-tr-ok" : "text-tr-fail"}`}>
              {status.text}
            </div>
          )}

          {/* recent log */}
          <section>
            <div className="px-1 pb-1 text-[11px] font-medium text-tr-muted">Recent</div>
            {snap.log.length === 0 && (
              <div className="px-1 py-0.5 text-[11.5px] text-tr-muted/70">No commits yet.</div>
            )}
            {snap.log.map(c => (
              <div key={c.sha} className="flex items-baseline gap-2 rounded-md px-1 py-[3px]">
                <span className="tr-mono shrink-0 text-[11px] text-tr-doing">{c.sha}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px]" title={`${c.author} · ${c.when} · ${c.subject}`}>{c.subject}</span>
                <span className="tr-mono shrink-0 text-[10.5px] text-tr-muted/70">{c.when}</span>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
