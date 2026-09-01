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
import { isLspLive, onLspChange } from "./lspClient";
import "./monacoSetup";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function CodeView({ value, path, root, editable, onChange, onSave }: {
  value: string;
  path: string;
  /** The scope root the language server chose — the model's URI is `root/path` so didOpen names
   *  a real file, not an inmemory:// URI rust-analyzer cannot map into the crate. */
  root?: string | null;
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
    const lang = monacoLanguageFor(path);
    // The model URI is the file's absolute path under the server root; monaco keys models by URI,
    // so reuse an existing model for this URI rather than create a duplicate (createModel throws
    // on a registered URI). No root → no URI, which is fine for a language with no server.
    const uri: monaco.Uri | undefined = root ? monaco.Uri.file(`${root}/${path}`) : undefined;
    const reused = uri ? monaco.editor.getModel(uri) : null;
    const model = reused ?? monaco.editor.createModel(value, lang, uri);
    const ed = monaco.editor.create(host.current, {
      model,
      theme: "trantor-calm",
      readOnly: !editable,
      automaticLayout: true,
      ...fontOptions,
      // Minimap ON (2026-09-01): with it off, monaco read as "nothing changed" to the operator —
      // the minimap is half of the editor's VS Code identity, and identity was the point (#5790).
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      renderLineHighlight: "line",
      // Suggestions only when a language server is live for this language (#5857): the muted
      // built-in TS service is not consulted, and an editor with no server keeps today's silence.
      quickSuggestions: isLspLive(lang),
      suggestOnTriggerCharacters: isLspLive(lang),
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
      // Dispose only the model WE created; a reused model belongs to whichever editor made it.
      if (!reused) model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Deliberately NOT keyed on `value`: re-creating on every keystroke is how an editor loses
    // the cursor. A caller changing the file changes `path` (or the server root lands), which is
    // the real identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable, root]);

  // The language server starts async, after this editor is already up: when it comes (or goes)
  // live, flip suggestions for THIS instance so the first completion needs no remount.
  useEffect(() => {
    const lang = monacoLanguageFor(path);
    return onLspChange(() => {
      const ed = editorRef.current;
      if (!ed) return;
      const live = isLspLive(lang);
      ed.updateOptions({ quickSuggestions: live, suggestOnTriggerCharacters: live });
    });
  }, [path]);

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
