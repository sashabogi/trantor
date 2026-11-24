// A file tab (#13988): the classic Monaco CodeView, imported not forked, with a save button, the
// review chip and breadcrumbs. Loaded lazily so Monaco and its workers stay out of every other screen.
import { useEffect, useState } from "react";
import { CodeView } from "../../../features/code/CodeView";
import { ReviewChip } from "../../../features/code/ReviewChip";
import { readFile, writePlain } from "../../../features/code/fileApi";
import { Button } from "../../ui/Button";

type Load = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; disk: string; truncated: boolean };

export default function FileEditor({ project, scope, path, onOpenGraph }: { project: string; scope: string | null; path: string; onOpenGraph: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoad({ kind: "loading" });
    readFile(project, path, scope ?? undefined)
      .then(b => { if (alive) { setLoad({ kind: "ok", disk: b.text, truncated: b.truncated }); setDraft(b.text); } })
      .catch(e => { if (alive) setLoad({ kind: "error", reason: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [project, scope, path]);
  if (load.kind === "loading") return <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">Reading {path}</div>;
  if (load.kind === "error") return <div role="alert" className="px-4 py-6 text-[12.5px] text-[var(--v2-bad)]">{load.reason}</div>;
  const dirty = draft !== load.disk;
  const save = () => {
    writePlain(project, path, scope ?? undefined, draft)
      .then(() => { setSaveError(null); setLoad({ kind: "ok", disk: draft, truncated: load.truncated }); })
      .catch(e => setSaveError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">
        <span className="v2-mono min-w-0 flex-1 truncate">{path.split("/").join(" › ")}</span>
        <ReviewChip project={project} seat={scope} path={path} onOpenGraph={onOpenGraph} />
        {load.truncated && <span className="text-[var(--v2-warn)]">first 512 KB only: saving is off</span>}
        {saveError && <span role="alert" className="text-[var(--v2-bad)]">{saveError}</span>}
        <Button variant="ghost" onClick={save} disabledReason={load.truncated ? "The file is truncated, so saving would lose the rest" : !dirty ? "No unsaved changes" : null}>Save</Button>
      </div>
      <div className="min-h-0 flex-1">
        <CodeView value={draft} path={path} editable={!load.truncated} onChange={setDraft} onSave={save} project={project} seat={scope} />
      </div>
    </div>
  );
}
