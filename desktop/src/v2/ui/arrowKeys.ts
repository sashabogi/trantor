// #14268: Left and Right (or Up and Down) walk a row of tabs or radios, wrapping at the ends.
import type { KeyboardEvent } from "react";

export function arrowTarget(key: string, index: number, count: number, vertical = false): number {
  const [back, forward] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (key === forward) return (index + 1) % count;
  if (key === back) return (index - 1 + count) % count;
  return -1;
}

/** Selects the neighbour and moves focus to it; the siblings are found inside the event's parent. */
export function walkSiblings(e: KeyboardEvent<HTMLElement>, index: number, select: (to: number) => void, vertical = false) {
  const row = e.currentTarget.parentElement;
  const peers = row ? [...row.querySelectorAll<HTMLElement>('[role="tab"],[role="radio"]')] : [];
  const to = arrowTarget(e.key, index, peers.length, vertical);
  if (to < 0) return;
  e.preventDefault();
  select(to);
  peers[to]?.focus();
}
