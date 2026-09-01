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
import { registerGhostTextProvider, isGhostTextEnabled, toggleGhostText } from "./ghostText";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function CodeView({ value, path, root, editable, onChange, onSave, project, seat }: {
  value: string;
  path: string;
  /** The scope root the language server chose — the model's URI is `root/path` so didOpen names
   *  a real file, not an inmemory:// URI rust-analyzer cannot map into the crate. */
  root?: string | null;
  editable: boolean;
  onChange?: (v: string) => void;
  onSave?: () => void;
  project: string;
  seat: string | null;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const ghostDispRef = useRef<monaco.IDisposable | null>(null);
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
    if (editable && isGhostTextEnabled()) {
      ghostDispRef.current = registerGhostTextProvider(model);
    }
    editorRef.current = ed;
    modelRef.current = model;
    return () => {
      sub.dispose();
      ghostDispRef.current?.dispose();
      ghostDispRef.current = null;
      ed.dispose();
      // Dispose only the model WE created; a reused model belongs to whichever editor made it.
      if (!reused) model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Deliberately NOT keyed on `value`: re-creating on every keystroke is how an editor loses
    // the cursor. A caller changing the file changes `path` (or the server root lands), which is
    // the real identity here. project/seat scope the ghost-text calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable, root, project, seat]);

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

  const ghostOn = isGhostTextEnabled();
  const switchGhost = () => {
    const next = toggleGhostText();
    if (modelRef.current) {
      ghostDispRef.current?.dispose();
      ghostDispRef.current = null;
      if (next && editable) {
        ghostDispRef.current = registerGhostTextProvider(modelRef.current);
      }
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-lg">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-tr-edge bg-tr-panel/40">
        <button
          type="button"
          onClick={switchGhost}
          data-on={ghostOn}
          className="rounded-[7px] px-2 py-0.5 text-[11px] font-medium text-tr-muted data-[on=true]:bg-tr-ok data-[on=true]:text-[#07130f] data-[on=true]:shadow-sm hover:bg-tr-panel hover:text-tr-text"
          title="Predictive ghost text — Tab accepts, Esc dismisses"
        >
          ghost text
        </button>
      </div>
      <div ref={host} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
