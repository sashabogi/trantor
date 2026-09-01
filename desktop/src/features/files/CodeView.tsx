// A real editor, not a text box.
//
// Monaco replaces CodeMirror (#5790): literal VS Code editing — the engine Orca's editor
// surfaces run on — bundled locally through vite workers with no CDN (the wiring contract
// lives in monacoSetup.ts). The component contract is unchanged from the CodeMirror build:
// same props, path is the editor's identity (a rebuild keeps the cursor out of trouble), a
// new value for the same path replaces the text in place, ⌘S saves.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { monacoLanguageFor } from "./editorLanguage";
import "./monacoSetup";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function CodeView({ value, path, editable, onChange, onSave }: {
  value: string;
  path: string;
  editable: boolean;
  onChange?: (v: string) => void;
  /** ⌘S. Every developer tries it within ten seconds of an editor appearing. */
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  // Kept in refs so changing the handler never rebuilds the editor — a rebuild would drop the
  // cursor and the undo history mid-edit.
  const cb = useRef(onChange);
  cb.current = onChange;
  const saveCb = useRef(onSave);
  saveCb.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    // No URI on purpose: monaco keys models by URI and throws on a duplicate, and a remount of
    // the same file (StrictMode, tab flip) would collide. Language is passed explicitly.
    const model = monaco.editor.createModel(value, monacoLanguageFor(path));
    const ed = monaco.editor.create(host.current, {
      model,
      theme: "trantor-calm",
      readOnly: !editable,
      automaticLayout: true,
      ...fontOptions,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      renderLineHighlight: "line",
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      occurrencesHighlight: "off",
      padding: { top: 6, bottom: 6 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveCb.current?.();
    });
    const sub = ed.onDidChangeModelContent(() => {
      cb.current?.(ed.getValue());
    });
    editorRef.current = ed;
    modelRef.current = model;
    return () => {
      sub.dispose();
      ed.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Deliberately NOT keyed on `value`: re-creating on every keystroke is how an editor loses
    // the cursor. A caller changing the file changes `path`, which is the real identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable]);

  // A new document for the same path (saved, reloaded, switched source) replaces the text
  // without tearing the editor down. pushEditOperations keeps the undo stack, so a live reload
  // remains undoable — the silent-reload half of the liveReload rule.
  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden rounded-lg" />;
}
