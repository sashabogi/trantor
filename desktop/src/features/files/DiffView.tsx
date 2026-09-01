// A diff you can read code in.
//
// Monaco replaces CodeMirror (#5790): the two DOCUMENTS side by side — HEAD on the left, the
// working copy on the right — now in monaco's diff editor, the same surface VS Code's diff is.
// Contract unchanged from the CodeMirror build: same props, both sides read-only, unchanged
// regions collapsed. Judging the change happens here; editing belongs in the editor where
// saving commits it as you.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { monacoLanguageFor } from "./editorLanguage";
import "./monacoSetup";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function DiffView({ base, head, path }: { base: string; head: string; path: string }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const lang = monacoLanguageFor(path);
    const baseModel = monaco.editor.createModel(base, lang);
    const headModel = monaco.editor.createModel(head, lang);
    const ed = monaco.editor.createDiffEditor(host.current, {
      theme: "trantor-calm",
      automaticLayout: true,
      ...fontOptions,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      // The CodeMirror build collapsed unchanged regions with margin 3 / minSize 6; this is
      // monaco's spelling of the same calm.
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      diffCodeLens: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    ed.setModel({ original: baseModel, modified: headModel });
    return () => {
      ed.dispose();
      baseModel.dispose();
      headModel.dispose();
    };
  }, [base, head, path]);

  return <div ref={host} className="h-full min-h-0 overflow-auto rounded-lg" />;
}
