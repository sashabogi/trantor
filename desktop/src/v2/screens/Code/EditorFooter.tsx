// The strip under the editor: cursor position, selection size, language, indentation, line ending.
// It follows the live Monaco editor and lets go of its listeners when the editor changes.
import { useEffect, useState, type MutableRefObject } from "react";

type Span = { isEmpty(): boolean; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/** The part of the Monaco editor the footer reads; the real editor satisfies it. */
export type FooterEditor = {
  getModel(): { getOptions(): { insertSpaces: boolean; tabSize: number }; getLanguageId(): string; getEOL(): string; getValueInRange(range: Span): string; getLineCount(): number } | null;
  getPosition(): { lineNumber: number; column: number } | null;
  getSelection(): Span | null;
  onDidChangeCursorPosition(cb: () => void): { dispose(): void };
  onDidChangeCursorSelection(cb: () => void): { dispose(): void };
  onDidChangeModel(cb: () => void): { dispose(): void };
  onDidChangeModelOptions(cb: () => void): { dispose(): void };
  onDidChangeModelLanguage(cb: () => void): { dispose(): void };
  revealLineInCenter(line: number): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  focus(): void;
};

export type FooterInfo = {
  line: number; column: number; selected: number; language: string; indent: string; eol: "LF" | "CRLF";
};

export function footerInfo(ed: FooterEditor): FooterInfo | null {
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) return null;
  const sel = ed.getSelection();
  const options = model.getOptions();
  return {
    line: pos.lineNumber,
    column: pos.column,
    selected: sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0,
    language: model.getLanguageId(),
    indent: options.insertSpaces ? `Spaces: ${options.tabSize}` : "Tabs",
    eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
  };
}

const LANGUAGE_NAMES = new Map([
  ["plaintext", "Plain Text"], ["typescript", "TypeScript"], ["javascript", "JavaScript"], ["json", "JSON"],
  ["markdown", "Markdown"], ["rust", "Rust"], ["python", "Python"], ["html", "HTML"], ["css", "CSS"],
  ["yaml", "YAML"], ["shell", "Shell"], ["toml", "TOML"],
]);
const languageName = (id: string) => LANGUAGE_NAMES.get(id) ?? id.charAt(0).toUpperCase() + id.slice(1);

/** `version` bumps whenever a new editor is mounted, so the footer moves to it. */
export function EditorFooter({ editorRef, version }: { editorRef: MutableRefObject<FooterEditor | null>; version: number }) {
  const [info, setInfo] = useState<FooterInfo | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) { setInfo(null); return; }
    const refresh = () => setInfo(footerInfo(ed));
    refresh();
    const subs = [
      ed.onDidChangeCursorPosition(refresh), ed.onDidChangeCursorSelection(refresh), ed.onDidChangeModel(refresh),
      ed.onDidChangeModelOptions(refresh), ed.onDidChangeModelLanguage(refresh),
    ];
    return () => subs.forEach(s => s.dispose());
  }, [editorRef, version]);
  // Monaco's own go to line box does not show in this shell, so the footer asks for the line itself (#14105 drill).
  const goTo = (text: string) => {
    setAsking(false);
    const ed = editorRef.current;
    const model = ed?.getModel();
    const line = Number.parseInt(text, 10);
    if (!ed || !model || !Number.isFinite(line)) return;
    const target = Math.max(1, Math.min(model.getLineCount(), line));
    ed.revealLineInCenter(target);
    ed.setPosition({ lineNumber: target, column: 1 });
    // After this key press is over: focused at once, the editor also takes the Enter and adds a line.
    setTimeout(() => ed.focus(), 0);
  };
  if (!info) return null;
  return (
    <div className="v2-mono flex shrink-0 items-center gap-3 border-t border-[var(--v2-edge)] px-3 py-1 text-v2-small text-[var(--v2-muted)]">
      {asking ? (
        <input autoFocus aria-label="Go to line" placeholder="Line" inputMode="numeric" onBlur={() => setAsking(false)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); goTo(e.currentTarget.value); } else if (e.key === "Escape") setAsking(false); }}
          className="w-16 rounded border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] px-1 text-v2-small text-[var(--v2-text)] outline-none" />
      ) : (
        <button type="button" aria-label="Go to line" title="Go to line" className="v2-hover rounded px-1 text-left" onClick={() => setAsking(true)}>
          {`Ln ${info.line}, Col ${info.column}`}{info.selected > 0 && ` (${info.selected} selected)`}
        </button>
      )}
      <span className="flex-1" />
      <span>{info.indent}</span>
      <span>{info.eol}</span>
      <span>{languageName(info.language)}</span>
    </div>
  );
}
