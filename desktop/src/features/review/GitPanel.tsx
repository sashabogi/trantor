// The Review lens's git rail (#5775). Review showed the seat's diff but left every git action to
// a terminal; this panel is branch, stage/unstage, commit, push, and the recent log against the
// SELECTED seat's worktree, through the git_* commands in src-tauri. Every mutation is refused
// seat-side while the seat is working (the same guard write_file applies) — the refusal comes
// back verbatim and lands in the status line, never a dialog.
import { useCallback, useEffect, useState } from "react";
import {
  aheadLabel,
  bucketStatus,
  gitCommit,
  gitPanel,
  gitPush,
  gitStage,
  type GitPanelSnapshot,
} from "./gitApi";

export function GitPanel({ project, seat, onChanged }: {
  project: string; seat: string; onChanged?: () => void;
}) {
  const [snap, setSnap] = useState<GitPanelSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "fail"; text: string } | null>(null);

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
  const commitDisabled = busy || !buckets || buckets.staged.length === 0 || !msg.trim();
  const pushDisabled = busy || !snap || !snap.branch || snap.ahead === 0;

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

      {buckets && snap && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          {/* staged — each with an unstage button */}
          <section>
            <div className="px-1 pb-1 text-[11px] font-medium text-tr-muted">Staged ({buckets.staged.length})</div>
            {buckets.staged.length === 0 && (
              <div className="px-1 py-0.5 text-[11.5px] text-tr-muted/70">Nothing staged.</div>
            )}
            {buckets.staged.map(e => (
              <div key={`s-${e.path}`} className="group flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px]" title={`${e.x}${e.y} ${e.path}`}>{e.path}</span>
                <button
                  onClick={() => { void act(() => gitStage(project, seat, [e.path], true), `unstaged ${e.path}`); }}
                  disabled={busy}
                  title="unstage"
                  className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                >−</button>
              </div>
            ))}
          </section>

          {/* worktree changes + untracked — each stageable */}
          {(buckets.unstaged.length > 0 || buckets.untracked.length > 0) && (
            <section>
              <div className="px-1 pb-1 text-[11px] font-medium text-tr-muted">
                Changes ({buckets.unstaged.length + buckets.untracked.length})
              </div>
              {buckets.unstaged.map(e => (
                <div key={`u-${e.path}`} className="flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                  <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px]" title={`${e.x}${e.y} ${e.path}`}>{e.path}</span>
                  <button
                    onClick={() => { void act(() => gitStage(project, seat, [e.path]), `staged ${e.path}`); }}
                    disabled={busy}
                    title="stage"
                    className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                  >+</button>
                </div>
              ))}
              {buckets.untracked.map(p => (
                <div key={`n-${p}`} className="flex items-center gap-1.5 rounded-md px-1 py-[3px]">
                  <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px] text-tr-muted">{p}</span>
                  <span className="tr-chip shrink-0">new</span>
                  <button
                    onClick={() => { void act(() => gitStage(project, seat, [p]), `staged ${p}`); }}
                    disabled={busy}
                    title="stage"
                    className="shrink-0 rounded px-1.5 text-[12px] text-tr-muted hover:bg-white/[0.06] hover:text-tr-text disabled:opacity-40"
                  >+</button>
                </div>
              ))}
            </section>
          )}

          {/* commit + push */}
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
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
                  void act(async () => {
                    await gitCommit(project, seat, text);
                    setMsg("");
                  }, "committed");
                }}
                disabled={commitDisabled}
                className="shrink-0 rounded-lg bg-tr-doing/20 px-2.5 py-1.5 text-[11.5px] font-medium text-tr-doing disabled:opacity-40"
              >
                Commit
              </button>
            </div>
            <button
              onClick={() => { void act(async () => { await gitPush(project, seat); }, "pushed"); }}
              disabled={pushDisabled}
              title={!snap?.branch ? "detached HEAD" : snap.ahead === 0 ? "nothing to push" : `push ${snap.branch} to origin`}
              className="rounded-lg border border-tr-edge px-2.5 py-1.5 text-[11.5px] font-medium text-tr-text disabled:opacity-40"
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
