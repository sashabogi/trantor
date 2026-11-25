// A small anchored menu for the seat strip and inspector: Add seat, +N offline, Swap (#13987).
import { useEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem = { id: string; label: string; sub?: string; disabledReason?: string | null; onPick: () => void };

export function PopMenu({ trigger, heading, items, empty }: {
  /** Renders the button that opens the menu; spread `props` onto it. */
  trigger: (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }, open: boolean) => ReactNode;
  heading: string;
  items: MenuItem[];
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={root} className="relative inline-flex">
      {trigger({ onClick: () => setOpen(o => !o), "aria-haspopup": "menu", "aria-expanded": open }, open)}
      {open && (
        <div role="menu" aria-label={heading}
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-lg">
          <div className="px-2.5 pb-1 pt-1.5 text-v2-small font-semibold uppercase tracking-wider text-[var(--v2-muted)]">{heading}</div>
          {!items.length && <div className="px-2.5 py-2 text-v2-body text-[var(--v2-muted)]">{empty}</div>}
          {items.map(i => (
            <button key={i.id} type="button" role="menuitem" disabled={!!i.disabledReason} title={i.disabledReason ?? undefined}
              onClick={() => { setOpen(false); i.onPick(); }}
              className="v2-hover flex w-full flex-col rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-v2-body text-[var(--v2-text)] disabled:opacity-45">
              <span>{i.label}</span>
              {i.sub && <span className="text-v2-small text-[var(--v2-muted)]">{i.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
