import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="v2-mono inline-flex items-center rounded-[5px] border border-[var(--v2-edge-2)] px-[5px] text-[11px] leading-[16px] text-[var(--v2-muted)]">
      {children}
    </kbd>
  );
}
