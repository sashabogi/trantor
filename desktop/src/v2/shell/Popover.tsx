// A small anchored menu: Escape or a click outside closes it (#v2-F).
import { useEffect, useRef, type ReactNode } from "react";

export function Popover({ open, onClose, label, align = "left", children }: {
  open: boolean; onClose: () => void; label: string; align?: "left" | "right"; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // #13984 drill: the trigger sits in the same wrapper; a mousedown on it must not close then re-open on its click.
      const wrap = ref.current?.parentElement;
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target) && !wrap?.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} role="menu" aria-label={label}
      className={`absolute top-[calc(100%+6px)] z-50 min-w-[220px] max-h-[60vh] overflow-y-auto rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-[var(--v2-shadow-menu)] ${align === "right" ? "right-0" : "left-0"}`}>
      {children}
    </div>
  );
}

export function MenuItem({ onSelect, children, active, title }: {
  onSelect: () => void; children: ReactNode; active?: boolean; title?: string;
}) {
  return (
    <button type="button" role="menuitem" title={title} onClick={onSelect} aria-current={active || undefined}
      className={`v2-hover flex w-full items-center gap-2 rounded-[7px] border-0 px-2 py-1.5 text-left text-[12.5px] ${
        active ? "bg-[var(--v2-accent-soft)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-text-2)]"}`}>
      {children}
    </button>
  );
}
