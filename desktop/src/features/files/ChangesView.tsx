// The Changes view (#5809) — Orca's ChangesModeView anatomy copied, not adapted
// (RESEARCH-orca-renderer.md §2): the open file rendered as a HEAD-vs-editor diff WITHOUT a
// separate diff tab, and the EDITOR IS THE MODIFIED SIDE. The original (HEAD) is frozen; the
// modified side is live — every keystroke lands in the same draft the code view edits, so dirty
// tracking, save, and the conflict bar keep working in both views. This REPLACES the read-only
// DiffView: a diff you must leave to edit was the invented piece the deletion map retired.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { monacoLanguageFor } from "./editorLanguage";
import "./monacoSetup";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function ChangesView({ base, value, path, editable, onChange, onSave }: {
  /** The file as HEAD has it ("" for a file git has never seen — the whole file is new). */
  base: string;
  /** The LIVE draft — not a snapshot: keystrokes flow through onChange like the code view. */
  value: string;
  path: string;
  editable: boolean;
  onChange?: (v: string) => void;
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const saveCb = useRef(onSave);
  saveCb.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    // No URIs on purpose: monaco keys models by URI and throws on a duplicate, and a remount of
    // the same file (StrictMode, tab flip) would collide. Language is passed explicitly.
    const original = monaco.editor.createModel(base, monacoLanguageFor(path));
    const modified = monaco.editor.createModel(value, monacoLanguageFor(path));
    const ed = monaco.editor.createDiffEditor(host.current, {
      theme: "trantor-calm",
      automaticLayout: true,
      ...fontOptions,
      originalEditable: false,
      readOnly: !editable,
      renderSideBySide: true,
      // Orca's ChangesModeView keeps the editor live on the modified side; unchanged-context
      // collapse mirrors the calm the read-only diff had (#5790).
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      diffCodeLens: false,
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    ed.setModel({ original, modified });
    ed.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveCb.current?.();
    });
    const sub = ed.getModifiedEditor().onDidChangeModelContent(() => {
      cb.current?.(ed.getModifiedEditor().getValue());
    });
    originalRef.current = original;
    modifiedRef.current = modified;
    editorRef.current = ed;
    return () => {
      sub.dispose();
      ed.dispose();
      original.dispose();
      modified.dispose();
      originalRef.current = null;
      modifiedRef.current = null;
      editorRef.current = null;
    };
    // Rebuilt when the FILE changes (path is identity). `base` and `value` flow through the two
    // sync effects below so a reload never tears the editor — and the modified undo stack — down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable]);

  // New HEAD under the file (a commit, a pull, a seat landing) swaps the original side while the
  // modified side — and its undo history — survives. Same rotation reasoning as
  // ChangesModeView.tsx:69-75, spelled with a plain content replace.
  useEffect(() => {
    const m = originalRef.current;
    if (!m || m.getValue() === base) return;
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text: base }], () => null);
  }, [base]);

  // The draft flows in live from the shared tab state; this is the same document the code view
  // edits, so no echo guard is needed beyond the equality check.
  useEffect(() => {
    const m = modifiedRef.current;
    if (!m || m.getValue() === value) return;
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text: value }], () => null);
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden rounded-lg" />;
}
