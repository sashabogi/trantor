import { useEffect, useState, useSyncExternalStore } from "react";
import { surfaceFor } from "../../../features/workspace/herdr";
import { previewNote, previewStore } from "./previewStore";

export function usePreviews(project: string) {
  const items = useSyncExternalStore(previewStore.subscribe, () => previewStore.read(project));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    let alive = true;
    // A tab switch detaches its viewer, not the server; check the surface while the Browser is open too.
    const timer = setInterval(() => {
      tick(n => n + 1);
      const seats = new Map(items.filter(p => p.running).map(p => [p.seat, p]));
      for (const p of seats.values()) {
        void surfaceFor(project, p.seat, p.machine).then(location => {
          if (alive && !location.surface) previewStore.end(project, p.seat);
        }).catch(() => {});
      }
    }, 12_000);
    return () => { alive = false; clearInterval(timer); };
  }, [project, items]);
  return items.map(p => ({ ...p, note: previewNote(p) }));
}
