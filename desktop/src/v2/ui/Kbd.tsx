import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="v2-mono inline-flex items-center rounded-sm border border-[var(--v2-edge-2)] px-[5px] text-v2-small leading-[16px] text-[var(--v2-muted)]">
      {children}
    </kbd>
  );
}
