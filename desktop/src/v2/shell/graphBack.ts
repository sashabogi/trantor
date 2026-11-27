// #14495: which file Code opened FROM the graph, the 2.0 half of classic #11603. The Graph lens
// records it beside the file intent; Code shows the classic BackToGraph chip while the open tab
// IS that file, and the chip (or Cmd+[) returns and clears it.
import type { GraphOrigin } from "../../features/code/graph/graphOrigin";

let origin: GraphOrigin | null = null;
const watchers = new Set<() => void>();

const wake = () => watchers.forEach(w => w());

export function setGraphBack(next: GraphOrigin): void {
  origin = next;
  wake();
}

export function clearGraphBack(): void {
  if (origin === null) return;
  origin = null;
  wake();
}

export function currentGraphBack(): GraphOrigin | null {
  return origin;
}

/** Calls `onChange` whenever the origin is set or cleared; returns the call that stops it. */
export function watchGraphBack(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => { watchers.delete(onChange); };
}
