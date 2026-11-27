import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Subscriber = { changed: (paths: string[]) => void; failed: (message: string) => void };
type Watch = { subscribers: Set<Subscriber>; ready: Promise<() => void> };
const watches = new Map<string, Watch>();
const stopping = new Map<string, Promise<void>>();

// Rust owns one watcher per checkout scope. Share it across split editors and finish an old
// unwatch before starting a new watch during a quick tab switch or StrictMode remount.
export function watchFiles(project: string, scope: string | null, changed: Subscriber["changed"], failed: Subscriber["failed"]): () => void {
  const key = JSON.stringify([project, scope]);
  let watch = watches.get(key);
  if (!watch) {
    const subscribers = new Set<Subscriber>();
    const ready = (stopping.get(key) ?? Promise.resolve()).then(async () => {
      const unlisten = await listen<{ project: string; seat?: string | null; paths: string[] }>("file-changed", event => {
        if (event.payload.project === project && (event.payload.seat ?? null) === scope) {
          for (const sub of subscribers) sub.changed(event.payload.paths);
        }
      });
      try { await invoke("file_watch", { project, seat: scope }); }
      catch (error) { unlisten(); throw error; }
      for (const sub of subscribers) sub.changed([]);
      return unlisten;
    });
    watch = { subscribers, ready };
    watches.set(key, watch);
    void ready.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      for (const sub of subscribers) sub.failed(message);
    });
  }
  const sub = { changed, failed };
  watch.subscribers.add(sub);
  const owned = watch;
  return () => {
    if (!owned.subscribers.delete(sub) || owned.subscribers.size > 0) return;
    watches.delete(key);
    const stopped = owned.ready.then(async unlisten => {
      unlisten();
      await invoke("file_unwatch", { project, seat: scope });
    }).catch(error => failed(error instanceof Error ? error.message : String(error)));
    stopping.set(key, stopped);
    void stopped.then(() => { if (stopping.get(key) === stopped) stopping.delete(key); });
  };
}
