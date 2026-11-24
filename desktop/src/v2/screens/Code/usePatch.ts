// Patch readers for the diff pane (#13988): one file's diff against HEAD, or a seat branch against main.
import { useEffect, useState } from "react";
import { fileDiff } from "../../../features/code/fileApi";
import { seatDiff, type SeatDiffFile } from "../../../features/code/seatDiff";
import type { PatchState } from "./DiffPane";
import { scopeShow, type GitShowFile } from "./scopeGitApi";

const message = (e: Error | string) => (e instanceof Error ? e.message : String(e));

/** `sig` changes when the working tree does, so a stage or an edit refreshes the diff without a loading flash. */
export function useFileDiff(project: string, scope: string | null, path: string | null, sig: string): PatchState {
  const [state, setState] = useState<PatchState>({ kind: "loading" });
  useEffect(() => { setState({ kind: "loading" }); }, [project, scope, path]);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    fileDiff(project, path, scope ?? undefined)
      .then(patch => { if (alive) setState({ kind: "ok", patch }); })
      .catch(e => { if (alive) setState({ kind: "error", reason: message(e) }); });
    return () => { alive = false; };
  }, [project, scope, path, sig]);
  return path ? state : { kind: "ok", patch: "" };
}

export type CommitPatch = { state: PatchState; files: GitShowFile[] };

/** One commit's own files and patch, on either checkout (#13988 drill: git_show). */
export function useCommitShow(project: string, scope: string | null, sha: string | null): CommitPatch {
  const [out, setOut] = useState<CommitPatch>({ state: { kind: "loading" }, files: [] });
  useEffect(() => {
    setOut({ state: { kind: "loading" }, files: [] });
    if (!sha) return;
    let alive = true;
    scopeShow(project, scope, sha)
      .then(c => { if (alive) setOut({ state: { kind: "ok", patch: c.patch, truncated: c.truncated }, files: c.files }); })
      .catch(e => { if (alive) setOut({ state: { kind: "error", reason: message(e) }, files: [] }); });
    return () => { alive = false; };
  }, [project, scope, sha]);
  return out;
}

export type SeatBranchDiff ={ state: PatchState; files: SeatDiffFile[]; base: string | null };

/** The seat's whole unlanded work against its merge base with main. */
export function useSeatDiff(project: string, seat: string | null, enabled: boolean, sig: string): SeatBranchDiff {
  const [out, setOut] = useState<SeatBranchDiff>({ state: { kind: "loading" }, files: [], base: null });
  useEffect(() => {
    if (!seat || !enabled) return;
    let alive = true;
    seatDiff(project, seat)
      .then(d => { if (alive) setOut({ state: { kind: "ok", patch: d.patch, truncated: d.truncated }, files: d.files, base: d.base }); })
      .catch(e => { if (alive) setOut({ state: { kind: "error", reason: message(e) }, files: [], base: null }); });
    return () => { alive = false; };
  }, [project, seat, enabled, sig]);
  return out;
}
