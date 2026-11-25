// Gutter and overview ruler marks for lines added, changed or removed against HEAD. Type-only
// Monaco imports keep this testable without an editor.
import { useEffect, type MutableRefObject } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { readFileAtHead } from "../../../features/code/fileApi";
import { diffLines, type MarkKind, type MarkRun } from "./lineDiff";

export const MARKER_DEBOUNCE_MS = 300;
const RULER_LANE_LEFT = 1; // monaco.editor.OverviewRulerLane.Left, kept numeric so Monaco's runtime is not imported here
const themeVar = (kind: MarkKind) => (kind === "added" ? "--v2-ok" : kind === "changed" ? "--v2-warn" : "--v2-bad");

type Spec = MonacoEditor.IModelDeltaDecoration;

/** A removed run past the last line is drawn on the bottom edge of the last line. */
export function decorationsFor(runs: MarkRun[], lineCount: number, colors: Record<MarkKind, string>): Spec[] {
  return runs.map(run => {
    const below = run.kind === "removed" && run.from > lineCount;
    const from = Math.max(1, Math.min(run.from, lineCount));
    const to = Math.max(from, Math.min(run.to, lineCount));
    const className = run.kind === "removed" ? (below ? "v2-cm-removed-below" : "v2-cm-removed") : `v2-cm-${run.kind}`;
    return {
      range: { startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: className,
        overviewRuler: { color: colors[run.kind], position: RULER_LANE_LEFT },
      },
    };
  });
}

function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const pick = (kind: MarkKind) => style.getPropertyValue(themeVar(kind)).trim() || `var(${themeVar(kind)})`;
  return { added: pick("added"), changed: pick("changed"), removed: pick("removed") };
}

/** `version` bumps whenever a new editor is mounted; `disk` changes when a save lands; `headRev` when a commit does. */
export function useChangeMarkers(
  editorRef: MutableRefObject<MonacoEditor.IStandaloneCodeEditor | null>, version: number,
  project: string, scope: string | null, path: string, disk: string | null, headRev: string | null,
) {
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || disk === null) return;
    const collection = ed.createDecorationsCollection();
    let head: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const apply = () => {
      const model = ed.getModel();
      // An empty HEAD side means a new or untracked file: no markers.
      const runs = model && head ? diffLines(head, model.getValue()) : null;
      collection.set(model && runs ? decorationsFor(runs, model.getLineCount(), themeColors()) : []);
    };
    void readFileAtHead(project, path, scope ?? undefined).then(text => { if (alive) { head = text; apply(); } }, () => {});
    const sub = ed.onDidChangeModelContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, MARKER_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      sub.dispose();
      collection.clear();
    };
  }, [editorRef, version, project, scope, path, disk, headRev]);
}
