import type { ReactNode } from "react";

/** Keys are symbols (⌘ ↵ ⇧), and the 2.0 mono face has no glyph for them: the system font always does.
 *  `onAccent` is for a key hint inside an accent-filled button. */
export function Kbd({ children, onAccent = false }: { children: ReactNode; onAccent?: boolean }) {
  const tone = onAccent ? "border-[var(--v2-ink)]/25 text-[var(--v2-ink)]/70" : "border-[var(--v2-edge-2)] text-[var(--v2-muted)]";
  return (
    <kbd className={`inline-flex items-center rounded-sm border px-[5px] font-[system-ui] text-v2-small leading-[16px] ${tone}`}>
      {children}
    </kbd>
  );
}
