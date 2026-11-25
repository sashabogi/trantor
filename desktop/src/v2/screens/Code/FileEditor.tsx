// A file tab (#13988): the classic Monaco CodeView, imported not forked, with a save button, the
// review chip and breadcrumbs. Loaded lazily so Monaco and its workers stay out of every other screen.
// #14072: dirty and save live in useFileDoc, reported up for the tab's dot and the git refresh.
import { useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { CodeView } from "../../../features/code/CodeView";
import { ImportedBy } from "./ImportedBy";
import { Button } from "../../ui/Button";
import { AskControls, type AskSeat } from "./AskControls";
import { useAskActions } from "./useAskActions";
import { useFileDoc } from "./useFileDoc";
import { EditorFooter } from "./EditorFooter";
import { useChangeMarkers } from "./useChangeMarkers";
import { FilePreview, previewKind } from "./FilePreview";
import { FileHistoryControl } from "./HistoryView";

const NO_SEATS: AskSeat[] = [];

export type Reveal = { line: number; column?: number; nonce: number };

function revealAt(ed: MonacoEditor.IStandaloneCodeEditor, r: Reveal) {
  ed.revealLineInCenter(r.line);
  ed.setPosition({ lineNumber: r.line, column: r.column ?? 1 });
  ed.focus();
}

function TextFileEditor({ project, scope, path, reveal, headRev = null, onOpenFile, onDirty, onSaved, seats = NO_SEATS, onAsk, onSendToSeat }: {
  project: string; scope: string | null; path: string; reveal?: Reveal; headRev?: string | null; onOpenFile?: (path: string) => void;
  onDirty?: (dirty: boolean) => void; onSaved?: () => void;
  seats?: AskSeat[]; onAsk?: (text: string) => void; onSendToSeat?: (seat: string, text: string) => void;
}) {
  const doc = useFileDoc(project, scope, path, onDirty, onSaved);
  const [seatMenu, setSeatMenu] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  useAskActions(editorRef, editorVersion, { path, scope, seats, onAsk, onSendToSeat, openMenu: () => setSeatMenu(true) });
  const loaded = doc.load.kind === "ok";
  useChangeMarkers(editorRef, editorVersion, project, scope, path, doc.load.kind === "ok" ? doc.load.disk : null, headRev);
  // Reveal a search hit once the editor exists and whenever a new click arrives (#14074).
  useEffect(() => {
    if (!loaded) { editorRef.current = null; return; }
    if (reveal && editorRef.current) revealAt(editorRef.current, reveal);
  }, [reveal, loaded]);
  if (doc.load.kind === "loading") return <div className="px-4 py-6 text-v2-base text-[var(--v2-muted)]">Reading {path}</div>;
  if (doc.load.kind === "error") return <div role="alert" className="px-4 py-6 text-v2-base text-[var(--v2-bad)]">{doc.load.reason === "binary file" ? "This file is not text" : doc.load.reason}</div>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">
        <span className="v2-mono min-w-0 flex-1 truncate">{path.split("/").join(" › ")}</span>
        <ImportedBy project={project} scope={scope} path={path} onOpenFile={onOpenFile} />
        <FileHistoryControl project={project} scope={scope} path={path} />
        {doc.load.truncated && <span className="text-[var(--v2-warn)]">first 512 KB only: saving is off</span>}
        {doc.saveError && <span role="alert" className="text-[var(--v2-bad)]">{doc.saveError}</span>}
        <AskControls getEditor={() => editorRef.current} path={path} scope={scope} seats={seats} menuOpen={seatMenu} onMenuOpen={setSeatMenu} onAsk={onAsk} onSendToSeat={onSendToSeat} />
        <Button variant="ghost" onClick={doc.save} disabledReason={doc.load.truncated ? "The file is truncated, so saving would lose the rest" : !doc.dirty ? "No unsaved changes" : null}>Save</Button>
      </div>
      <div className="min-h-0 flex-1">
        <CodeView value={doc.draft} path={path} editable={!doc.load.truncated} onChange={doc.edit} onSave={doc.save} project={project} seat={scope} showGhostToggle={false}
          onReady={ed => { editorRef.current = ed; setEditorVersion(v => v + 1); if (reveal) revealAt(ed, reveal); }} />
      </div>
      <EditorFooter editorRef={editorRef} version={editorVersion} />
    </div>
  );
}

/** Markdown and images open in a preview; every other file is the text editor above. */
export default function FileEditor(props: Parameters<typeof TextFileEditor>[0]) {
  const kind = previewKind(props.path);
  if (!kind) return <TextFileEditor {...props} />;
  return <FilePreview kind={kind} project={props.project} scope={props.scope} path={props.path} source={<TextFileEditor {...props} />} />;
}
