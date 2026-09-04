// A real editor, not a text box.
//
// Monaco replaces CodeMirror (#5790): literal VS Code editing — the engine Orca's editor
// surfaces run on — bundled locally through vite workers with no CDN (the wiring contract
// lives in monacoSetup.ts). The component contract is unchanged from the CodeMirror build:
// same props, path is the editor's identity (a rebuild keeps the cursor out of trouble), a
// new value for the same path replaces the text in place, ⌘S saves.
//
// No language server (#6437, following Orca's own shape): a month of custom LSP glue (start
// caps, client reuse, root-key matching) produced a steady stream of #5857-class failures and
// the operator still had no completions. Suggestions are Monaco's own built-ins — quick
// suggestions, trigger characters, word-based — same as any file with no semantic service.
// Ghost text (registerGhostTextProvider) is unrelated and unchanged.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { monacoLanguageFor } from "./editorLanguage";
import { storedDraft } from "./documents";
import "./monacoSetup";
import { registerGhostTextProvider, isGhostTextEnabled, toggleGhostText } from "./ghostText";

const fontOptions = {
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
} as const;

export function CodeView({ value, path, editable, onChange, onSave, project, seat }: {
  value: string;
  path: string;
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
  // Setup guard (#5857 bounce): while the model is being created/re-created and the resumed
  // text applied, onDidChangeModelContent must NOT reach onChange — a setup event carrying ""
  // would overwrite the store's resumed draft (the empty-editor regression, seen live 0.3.103).
  const setupRef = useRef(true);
  const cb = useRef(onChange);
  cb.current = onChange;
  const saveCb = useRef(onSave);
  saveCb.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    setupRef.current = true;
    const lang = monacoLanguageFor(path);
    // The model is created from the STORE's resumed draft when one exists — the `value` prop can
    // still be "" on this very render (the document loads after mount), and a model born empty
    // is what let a setup change write "" over the draft. The caller's value effect applies the
    // prop the moment it is real; until then the model simply holds the resumed text.
    const resumed = storedDraft(project, seat, path);
    const initialText = resumed ?? value;
    const model = monaco.editor.createModel(initialText, lang);
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
      // No language server (#6437): Monaco's own built-ins, same as any file with no semantic
      // service — quick suggestions, trigger characters, and a word-based fallback.
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      occurrencesHighlight: "off",
      padding: { top: 6, bottom: 6 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveCb.current?.();
    });
    const sub = ed.onDidChangeModelContent(() => {
      if (setupRef.current) return; // setup events never write the document (#5857 bounce)
      cb.current?.(ed.getValue());
    });
    if (editable && isGhostTextEnabled()) {
      ghostDispRef.current = registerGhostTextProvider(model);
    }
    editorRef.current = ed;
    modelRef.current = model;
    // Setup is over the moment the editor is up (#5938, the third face, 0.3.114): this effect
    // re-runs when `path` changes, and nothing else cleared the guard when the value prop did
    // not change afterwards — every keystroke was then muted, the store never saw the typed
    // text, and the next remount resumed the disk text. The value effect still raises and lowers
    // the guard around its own push.
    setupRef.current = false;
    return () => {
      sub.dispose();
      ghostDispRef.current?.dispose();
      ghostDispRef.current = null;
      ed.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Deliberately NOT keyed on `value`: re-creating on every keystroke is how an editor loses
    // the cursor. A caller changing the file changes `path`, which is the real identity here.
    // project/seat scope the ghost-text calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable, project, seat]);

  // A new document for the same path (saved, reloaded, switched source) replaces the text
  // without tearing the editor down. pushEditOperations keeps the undo stack, so a live reload
  // remains undoable — the silent-reload half of the liveReload rule. One skip (#5857 bounce):
  // while a resumed tab is still loading, the prop is "" and the model holds the STORE's resumed
  // draft — pushing "" here would erase it. That artifact never applies; setup stays on.
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    if (model.getValue() === value) { setupRef.current = false; return; }
    const resumed = storedDraft(project, seat, path);
    if (value === "" && resumed !== null && resumed !== "" && model.getValue() !== "") return;
    setupRef.current = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    setupRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
