// A small anchored menu whose rows can open a second level: the seat bar and strip "..." menus (#14351).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type ActionItem = {
  id: string; label: string; icon?: ReactNode; danger?: boolean; disabledReason?: string | null;
  onPick?: () => void;
  /** Opens a second level in the same menu, with its own heading. */
  sub?: { heading: string; items: ActionItem[]; empty?: string };
};

export function ActionMenu({ trigger, label, items }: {
  trigger: (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }) => ReactNode;
  /** Accessible name of the top level. */
  label: string; items: ActionItem[];
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<ActionItem["sub"] | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const close = () => { setOpen(false); setLevel(null); };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) { setOpen(false); setLevel(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setLevel(null); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);
  const shown = level ? level.items : items;
  return (
    <span ref={root} className="relative inline-flex">
      {trigger({ onClick: () => (open ? close() : setOpen(true)), "aria-haspopup": "menu", "aria-expanded": open })}
      {open && (
        <div role="menu" aria-label={level ? level.heading : label}
          className="v2-pop absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-[var(--v2-shadow-menu)]">
          {level && (
            <button type="button" onClick={() => setLevel(null)}
              className="v2-hover flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-v2-small font-semibold text-[var(--v2-muted)]">
              <ChevronLeft size={12} aria-hidden />Back
            </button>
          )}
          {level && !shown.length && <div className="px-2.5 py-2 text-v2-body text-[var(--v2-muted)]">{level.empty ?? "Nothing here"}</div>}
          {shown.map(i => (
            <button key={i.id} type="button" role="menuitem" disabled={!!i.disabledReason} title={i.disabledReason ?? undefined}
              onClick={() => { if (i.sub) setLevel(i.sub); else { close(); i.onPick?.(); } }}
              className={`v2-hover flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-v2-body disabled:opacity-45 ${i.danger ? "text-[var(--v2-bad)]" : "text-[var(--v2-text)]"}`}>
              {i.icon}<span className="min-w-0 flex-1 truncate">{i.label}</span>
              {i.sub && <ChevronRight size={12} className="text-[var(--v2-muted)]" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
