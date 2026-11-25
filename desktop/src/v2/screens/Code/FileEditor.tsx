// A file tab (#13988): the classic Monaco CodeView, imported not forked, with a save button, the
// review chip and breadcrumbs. Loaded lazily so Monaco and its workers stay out of every other screen.
// #14072: dirty and save live in useFileDoc, reported up for the tab's dot and the git refresh.
import { useEffect, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { CodeView } from "../../../features/code/CodeView";
import { ReviewChip } from "../../../features/code/ReviewChip";
import { Button } from "../../ui/Button";
import { useFileDoc } from "./useFileDoc";

export type Reveal = { line: number; column?: number; nonce: number };

function revealAt(ed: MonacoEditor.IStandaloneCodeEditor, r: Reveal) {
  ed.revealLineInCenter(r.line);
  ed.setPosition({ lineNumber: r.line, column: r.column ?? 1 });
  ed.focus();
}

export default function FileEditor({ project, scope, path, reveal, onOpenGraph, onDirty, onSaved }: {
  project: string; scope: string | null; path: string; reveal?: Reveal; onOpenGraph: () => void;
  onDirty?: (dirty: boolean) => void; onSaved?: () => void;
}) {
  const doc = useFileDoc(project, scope, path, onDirty, onSaved);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const loaded = doc.load.kind === "ok";
  // Reveal a search hit once the editor exists and whenever a new click arrives (#14074).
  useEffect(() => {
    if (!loaded) { editorRef.current = null; return; }
    if (reveal && editorRef.current) revealAt(editorRef.current, reveal);
  }, [reveal, loaded]);
  if (doc.load.kind === "loading") return <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">Reading {path}</div>;
  if (doc.load.kind === "error") return <div role="alert" className="px-4 py-6 text-[12.5px] text-[var(--v2-bad)]">{doc.load.reason}</div>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">
        <span className="v2-mono min-w-0 flex-1 truncate">{path.split("/").join(" › ")}</span>
        <ReviewChip project={project} seat={scope} path={path} onOpenGraph={onOpenGraph} />
        {doc.load.truncated && <span className="text-[var(--v2-warn)]">first 512 KB only: saving is off</span>}
        {doc.saveError && <span role="alert" className="text-[var(--v2-bad)]">{doc.saveError}</span>}
        <Button variant="ghost" onClick={doc.save} disabledReason={doc.load.truncated ? "The file is truncated, so saving would lose the rest" : !doc.dirty ? "No unsaved changes" : null}>Save</Button>
      </div>
      <div className="min-h-0 flex-1">
        <CodeView value={doc.draft} path={path} editable={!doc.load.truncated} onChange={doc.edit} onSave={doc.save} project={project} seat={scope}
          onReady={ed => { editorRef.current = ed; if (reveal) revealAt(ed, reveal); }} />
      </div>
    </div>
  );
}
