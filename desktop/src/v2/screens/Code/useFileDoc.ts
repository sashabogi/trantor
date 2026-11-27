import { useEffect, useRef, useState } from "react";
import { readFile, writePlain, type FileBody } from "../../../features/code/fileApi";
import { draftBaseline, draftDrop, draftFor, draftKeep } from "./drafts";
import { watchFiles } from "./fileWatch";

export type DocLoad = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; disk: string; truncated: boolean };
type DocState = { load: DocLoad; draft: string; conflict: FileBody | null; saveError: string | null; saving: boolean };
export type FileDoc = DocState & {
  dirty: boolean;
  edit: (text: string) => void;
  save: () => void;
  keepMine: () => void;
  loadTheirs: () => void;
};
type Session = { edit: FileDoc["edit"]; save: FileDoc["save"]; keepMine: FileDoc["keepMine"]; loadTheirs: FileDoc["loadTheirs"] };
const initial = (): DocState => ({ load: { kind: "loading" }, draft: "", conflict: null, saveError: null, saving: false });

export function useFileDoc(project: string, scope: string | null, path: string, onDirty?: (dirty: boolean) => void, onSaved?: () => void): FileDoc {
  const [state, setState] = useState<DocState>(initial);
  const session = useRef<Session | null>(null);
  const dirtyCb = useRef(onDirty);
  dirtyCb.current = onDirty;
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;

  useEffect(() => {
    let alive = true;
    let current = initial();
    let queue = Promise.resolve();
    const publish = (patch: Partial<DocState>) => {
      if (!alive) return;
      current = { ...current, ...patch };
      setState(current);
    };
    const cache = () => {
      if (current.load.kind !== "ok") return;
      if (current.draft === current.load.disk && !current.conflict) draftDrop(project, scope, path);
      else draftKeep(project, scope, path, current.draft, current.load.disk);
    };
    const accept = (body: FileBody) => {
      publish({ load: { kind: "ok", disk: body.text, truncated: body.truncated }, draft: body.text, conflict: null, saveError: null });
      cache();
    };
    const observe = (body: FileBody) => {
      if (!alive) return;
      if (current.load.kind !== "ok") {
        const kept = draftFor(project, scope, path);
        const base = draftBaseline(project, scope, path) ?? body.text;
        publish({ load: { kind: "ok", disk: base, truncated: body.truncated }, draft: kept ?? body.text });
      }
      if (current.load.kind !== "ok") return;
      if (current.draft === body.text || (current.draft === current.load.disk && !current.conflict)) accept(body);
      else {
        publish({ conflict: body.text !== current.load.disk || body.truncated ? body : null, saveError: null });
        cache();
      }
    };
    // Reads and saves share a queue so a late watcher read cannot undo a completed save.
    // Edits remain live while IO is pending; save completion retains any newer draft.
    const enqueue = (operation: () => Promise<void>) => {
      queue = queue.then(async () => { if (alive) await operation(); }).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (alive) publish(current.load.kind === "loading"
          ? { load: { kind: "error", reason: message } }
          : { saveError: message });
      });
    };
    const refresh = () => enqueue(async () => { observe(await readFile(project, path, scope ?? undefined)); });
    publish(current);
    const stopWatching = watchFiles(project, scope, paths => {
      if (paths.length === 0 || paths.includes(path)) refresh();
    }, message => publish({ saveError: `Cannot watch this file: ${message}` }));
    refresh();

    session.current = {
      edit(text) { publish({ draft: text }); cache(); },
      save() {
        if (current.saving || current.conflict || current.load.kind !== "ok" || current.load.truncated || current.draft === current.load.disk) return;
        publish({ saving: true, saveError: null });
        enqueue(async () => {
          try {
            const disk = await readFile(project, path, scope ?? undefined);
            if (!alive) return;
            observe(disk);
            if (current.conflict || current.load.kind !== "ok" || current.load.truncated || current.draft === current.load.disk) return;
            const text = current.draft;
            try { await writePlain(project, path, scope ?? undefined, text, current.load.disk); }
            catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (message !== "file_changed_on_disk") throw error;
              observe(await readFile(project, path, scope ?? undefined));
              return;
            }
            if (!alive) return;
            publish({ load: { kind: "ok", disk: text, truncated: false }, conflict: null, saveError: null });
            cache();
            savedCb.current?.();
          } finally { publish({ saving: false }); }
        });
      },
      keepMine() {
        if (!current.conflict || current.saving) return;
        const disk = current.conflict;
        publish({ load: { kind: "ok", disk: disk.text, truncated: disk.truncated }, conflict: null, saveError: null });
        cache();
      },
      loadTheirs() {
        if (current.conflict && !current.saving) accept(current.conflict);
      },
    };
    return () => { alive = false; session.current = null; stopWatching(); };
  }, [project, scope, path]);

  const dirty = state.load.kind === "ok" && state.draft !== state.load.disk;
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);
  return { ...state, dirty, edit: text => session.current?.edit(text), save: () => session.current?.save(),
    keepMine: () => session.current?.keepMine(), loadTheirs: () => session.current?.loadTheirs() };
}
