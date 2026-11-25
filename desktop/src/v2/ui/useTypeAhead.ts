// #14268: a menu's search field takes focus in the layout phase and catches keys typed before focus lands.
import { useLayoutEffect, useEffect, type RefObject } from "react";

const typing = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);

export function useTypeAhead(field: RefObject<HTMLInputElement | null>, active = true) {
  useLayoutEffect(() => { if (active) field.current?.focus(); }, [active, field]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const input = field.current;
      if (!input || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || typing(document.activeElement)) return;
      e.preventDefault();
      input.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, input.value + e.key);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, field]);
}
