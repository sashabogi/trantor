// The open file's document for FileEditor (#14072): read from disk, resume the unsaved draft the
// tab left behind, track dirty, save plainly. Beside FileEditor on purpose: this module imports
// no Monaco, so the flow stays testable (Monaco cannot render under happy-dom).
import { useEffect, useRef, useState } from "react";
import { readFile, writePlain } from "../../../features/code/fileApi";
import { draftDrop, draftFor, draftKeep } from "./drafts";

export type DocLoad = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; disk: string; truncated: boolean };

export type FileDoc = {
  load: DocLoad;
  draft: string;
  dirty: boolean;
  saveError: string | null;
  edit: (text: string) => void;
  save: () => void;
};

export function useFileDoc(project: string, scope: string | null, path: string, onDirty?: (dirty: boolean) => void, onSaved?: () => void): FileDoc {
  const [load, setLoad] = useState<DocLoad>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Callbacks ride refs: a parent re-render must not re-fire the dirty report effect below.
  const dirtyCb = useRef(onDirty);
  dirtyCb.current = onDirty;
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;

  useEffect(() => {
    let alive = true;
    setLoad({ kind: "loading" });
    readFile(project, path, scope ?? undefined)
      .then(b => { if (alive) { setLoad({ kind: "ok", disk: b.text, truncated: b.truncated }); setDraft(draftFor(project, scope, path) ?? b.text); } })
      .catch(e => { if (alive) setLoad({ kind: "error", reason: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [project, scope, path]);

  const dirty = load.kind === "ok" && draft !== load.disk;
  // #14072: the tab's dot. Load and mount report clean, edits report dirty, a landed save clean.
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);

  // Only unsaved text is cached: a draft equal to the disk would hide a later change made by an agent.
  const edit = (text: string) => {
    setDraft(text);
    if (load.kind === "ok" && text === load.disk) draftDrop(project, scope, path);
    else draftKeep(project, scope, path, text);
  };
  const save = () => {
    // A truncated file cannot save (the rest of the file would be lost) and a clean one has
    // nothing to write, so Cmd+S on either is a no-op, matching what the Save button already says.
    if (load.kind !== "ok" || load.truncated || !dirty) return;
    writePlain(project, path, scope ?? undefined, draft)
      .then(() => {
        setSaveError(null);
        draftDrop(project, scope, path);
        setLoad({ kind: "ok", disk: draft, truncated: load.truncated });
        savedCb.current?.();
      })
      .catch(e => setSaveError(e instanceof Error ? e.message : String(e)));
  };
  return { load, draft, dirty, saveError, edit, save };
}
