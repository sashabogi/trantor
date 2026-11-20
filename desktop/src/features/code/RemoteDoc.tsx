// The read-only viewer for ONE file of a seat on another machine (#13938): live body over ssh,
// the file's diff vs the seat's merge base, no editing — remote editing is out of scope for
// this slice and the banner says so. A deleted file falls through to its diff; an unreachable
// machine shows unreachable, never an empty viewer.
import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import { errorLine, isUnreachable, remoteFileBody, remoteFilePatch } from "./remoteSeatApi";

// Lazy on purpose: both viewers carry monaco, which loads only when their state is on screen.
const CodeView = lazy(() => import("./CodeView").then(m => ({ default: m.CodeView })));
const UnifiedDiffView = lazy(() => import("./ChangesView").then(m => ({ default: m.UnifiedDiffView })));

type Leg<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; reason: string; unreachable: boolean };

export function RemoteDoc({ project, seat, machine, path, diffView: DiffView = UnifiedDiffView }: {
  project: string;
  seat: string;
  machine: string;
  path: string;
  diffView?: ComponentType<{ value: string }>;
}) {
  const [view, setView] = useState<"file" | "diff">("file");
  const [body, setBody] = useState<Leg<{ text: string; truncated: boolean; bytes: number }>>({ state: "loading" });
  const [patch, setPatch] = useState<Leg<{ patch: string; truncated: boolean }>>({ state: "loading" });

  useEffect(() => {
    setBody({ state: "loading" });
    setPatch({ state: "loading" });
    setView("file");
    // The boundary parse for everything a remote read rejects with — Tauri hands Rust's
    // Err(String) through, and an Error instance (network stack edge) still yields its message.
    remoteFileBody(project, seat, machine, path)
      .then(v => setBody({ state: "ok", value: v }))
      .catch(e => {
        const reason = errorLine(e instanceof Error ? e.message : String(e));
        setBody({ state: "failed", reason, unreachable: isUnreachable(reason) });
        // the file is gone (deleted on the seat's branch) — the diff is the whole story left
        if (!isUnreachable(reason)) setView("diff");
      });
    remoteFilePatch(project, seat, machine, path)
      .then(v => setPatch({ state: "ok", value: v }))
      .catch(e => {
        const message = e instanceof Error ? e.message : String(e);
        setPatch({ state: "failed", reason: errorLine(message), unreachable: isUnreachable(message) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, seat, machine, path]);

  const unreachable = body.state === "failed" && body.unreachable;
  const bodyFailed = body.state === "failed" && !body.unreachable;
  const patchFailed = patch.state === "failed";

  if (unreachable) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
          <div>unreachable — {seat}'s worktree on {machine} could not be read.</div>
          <div className="tr-mono mt-2 text-[11px] text-tr-muted">{body.reason}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-1 pb-2">
        <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px] text-tr-muted">
          {path} · seat/{seat} on {machine}
        </span>
        <span className="shrink-0 rounded-[7px] border border-tr-edge px-2 py-0.5 text-[10.5px] text-tr-muted">
          read-only — remote editing is out of scope
        </span>
        <div className="flex shrink-0 items-center gap-1 rounded-[9px] bg-tr-panel/60 p-[3px]">
          {(["file", "diff"] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setView(m)}
              data-on={view === m}
              className="rounded-[7px] px-2.5 py-[5px] text-[11.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              {m === "file" ? "file" : "diff vs base"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-tr-edge bg-[#101013] p-1.5">
        {view === "diff" ? (
          patchFailed ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-tr-muted">
              {patch.state === "failed" ? patch.reason : ""}
            </div>
          ) : patch.state === "ok" && patch.value.patch.trim() === "" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-tr-muted">
              No diff vs base — this path is unchanged since the seat branched.
            </div>
          ) : patch.state === "ok" ? (
            <div className="flex h-full min-h-0 flex-col">
              <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-tr-muted/70">opening the diff…</div>}>
                <DiffView value={patch.value.patch} />
              </Suspense>
              {patch.value.truncated && (
                <div className="shrink-0 px-2 pb-2 text-[11px] text-tr-warn">Cut at 400 KB — this is the head of the diff, not all of it.</div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-tr-muted/70">reading the diff over ssh…</div>
          )
        ) : bodyFailed ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] leading-relaxed text-tr-muted">
            <div>
              {body.reason}
              {patch.state === "ok" && <div className="mt-2">The diff vs base is still readable — switch to it above.</div>}
            </div>
          </div>
        ) : body.state === "ok" ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-tr-muted/70">opening the viewer…</div>}>
            <CodeView value={body.value.text} path={path} editable={false} project={project} seat={seat} />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-tr-muted/70">reading over ssh…</div>
        )}
      </div>
      {body.state === "ok" && body.value.truncated && (
        <div className="px-1 pt-1.5 text-[11.5px] text-tr-warn">
          Cut at 512 KB — this is the head of the file, not all of it.
        </div>
      )}
    </div>
  );
}
