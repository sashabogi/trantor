// #14268: Up and Down walk the [data-nav] items of one group, Left and Right hop to the next group.
import type { KeyboardEvent } from "react";

export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const from = e.target instanceof HTMLElement && e.target.hasAttribute("data-nav") ? e.target : null;
  if (!from) return;
  const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
  const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
  if (!vertical && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const step = forward ? 1 : -1;
  let next: HTMLElement | undefined;
  if (vertical) {
    const group = from.closest<HTMLElement>("[data-nav-group]") ?? e.currentTarget;
    const items = [...group.querySelectorAll<HTMLElement>("[data-nav]")];
    next = items[items.indexOf(from) + step];
  } else {
    const groups = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-group]")];
    const here = groups.findIndex(g => g.contains(from));
    for (let i = here + step; i >= 0 && i < groups.length && !next; i += step) {
      next = groups[i]?.querySelector<HTMLElement>("[data-nav]") ?? undefined;
    }
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
}
