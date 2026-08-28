// A diff you can read code in.
//
// The first pass rendered `git diff` output as coloured text. That is a description of a change,
// not the change: no line numbers that match the file, no syntax, and every line prefixed with a
// character that breaks indentation. Reviewing an agent's work in it is worse than reading the
// file twice.
//
// This shows the two DOCUMENTS side by side — HEAD on the left, the working copy on the right —
// which is what "decide if you like the code" actually needs.
import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { languageFor } from "./CodeView";

export function DiffView({ base, head, path }: { base: string; head: string; path: string }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const shared = [
      lineNumbers(),
      highlightActiveLineGutter(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.theme({
        "&": { fontSize: "12px" },
        ".cm-scroller": { fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', lineHeight: "1.6" },
        "&.cm-focused": { outline: "none" },
      }),
      ...languageFor(path),
    ];
    const view = new MergeView({
      parent: host.current,
      // Read-only on both sides: this view is for judging the change, and editing belongs in the
      // editor where saving commits it as you.
      a: { doc: base, extensions: shared },
      b: { doc: head, extensions: shared },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }, [base, head, path]);

  return <div ref={host} className="h-full min-h-0 overflow-auto rounded-lg" />;
}
