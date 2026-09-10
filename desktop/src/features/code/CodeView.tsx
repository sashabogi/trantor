// Monaco replaces CodeMirror (#5790), bundled locally via vite workers with no CDN (wiring in
// monacoSetup.ts). Contract: path is the editor's identity, a new value for the same path
// replaces text in place, cmd+S saves. No language server (#6437): a month of custom LSP glue
// produced #5857-class failures with no completions, so suggestions are Monaco's own built-ins.
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
    // Setup guard must clear here when `path` changes (#5938): if nothing else clears it and
    // the value prop then does not change, every keystroke gets muted, the store never sees
    // the typed text, and remount resumes stale disk text. The value effect still raises and
    // lowers the guard around its own push.
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

  // A new document for the same path replaces the text via pushEditOperations, keeping the
  // undo stack so a live reload stays undoable (the silent-reload half of liveReload). Skip
  // when a resumed tab is still loading and the prop is empty (#5857): pushing "" here would
  // erase the store's resumed draft, so the push is skipped and setup stays on.
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
