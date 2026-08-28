// A real editor, not a text box.
//
// The first pass shipped a <pre> to read code in and a <textarea> to change it. For the operator
// this is built for — a developer who wants full control of code an agent wrote — that is not a
// smaller version of an editor, it is a different and worse thing. No line numbers, no syntax, no
// search, no bracket matching, and no way to tell at a glance what you are looking at.
//
// CodeMirror 6 rather than Monaco: it bundles in Vite without worker plumbing, and its merge
// addon gives a genuine side-by-side diff. Monaco is the swap if literal VS Code matters more than
// the bundle.
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";

/** The language for a path. Unknown extensions get no mode rather than a wrong one — highlighting
 *  a shell script as JavaScript is worse than plain text, because it looks authoritative. */
export function languageFor(path: string): Extension[] {
  const p = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) return [javascript({ typescript: /\.tsx?$/.test(p), jsx: /x$/.test(p) })];
  if (/\.rs$/.test(p)) return [rust()];
  if (/\.(md|markdown)$/.test(p)) return [markdown()];
  if (/\.py$/.test(p)) return [python()];
  if (/\.(json|lock)$/.test(p)) return [json()];
  return [];
}

const base = (editable: boolean): Extension[] => [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  foldGutter(),
  history(),
  bracketMatching(),
  indentOnInput(),
  highlightSelectionMatches(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  oneDark,
  EditorView.editable.of(editable),
  EditorState.readOnly.of(!editable),
  EditorView.theme({
    "&": { height: "100%", fontSize: "12px" },
    ".cm-scroller": { fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', lineHeight: "1.6" },
    "&.cm-focused": { outline: "none" },
  }),
];

export function CodeView({ value, path, editable, onChange, onSave }: {
  value: string;
  path: string;
  editable: boolean;
  onChange?: (v: string) => void;
  /** ⌘S. Every developer tries it within ten seconds of an editor appearing. */
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Kept in a ref so changing the handler never rebuilds the editor — a rebuild would drop the
  // cursor and the undo history mid-edit.
  const cb = useRef(onChange);
  cb.current = onChange;
  const saveCb = useRef(onSave);
  saveCb.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...base(editable),
          ...languageFor(path),
          // defaultKeymap does not bind Mod-s, so order does not matter here; preventDefault is
          // what stops the webview trying to save the page instead.
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { saveCb.current?.(); return true; } }]),
          EditorView.updateListener.of(u => { if (u.docChanged) cb.current?.(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // Deliberately NOT keyed on `value`: re-creating on every keystroke is how an editor loses the
    // cursor. A caller changing the file changes `path`, which is the real identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable]);

  // A new document for the same path (saved, reloaded, switched source) replaces the text without
  // tearing the editor down.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden rounded-lg" />;
}
