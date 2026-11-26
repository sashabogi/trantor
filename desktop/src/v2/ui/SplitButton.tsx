// #14344: a primary button with a chevron beside it that opens the rare actions of the same family.
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "../shell/Popover";

export type SplitItem = {
  label: string;
  onSelect: () => void;
  /** disables the item and says why */
  disabledReason?: string | null;
};

export type SplitButtonProps = {
  label: string;
  onPrimary: () => void;
  /** disables the primary button and says why */
  disabledReason?: string | null;
  menuLabel: string;
  items: SplitItem[];
  /** a quiet hint inside the primary button, such as the shortcut */
  hint?: ReactNode;
};

export function SplitButton({ label, onPrimary, disabledReason, menuLabel, items, hint }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const off = !!disabledReason;
  return (
    <div className="relative flex" data-split-button>
      <button type="button" onClick={onPrimary} disabled={off} aria-disabled={off || undefined} title={disabledReason ?? undefined}
        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-l-lg border-0 bg-[var(--v2-accent)] px-3 py-1.5 text-v2-body font-semibold text-[var(--v2-ink)] disabled:opacity-45">
        <span className="truncate">{label}</span>{hint}
      </button>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={menuLabel} title={menuLabel} onClick={() => setOpen(o => !o)}
        className="flex w-7 shrink-0 items-center justify-center rounded-r-lg border-0 border-l border-[var(--v2-ink)] bg-[var(--v2-accent)] text-[var(--v2-ink)]">
        <ChevronDown size={12} aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label={menuLabel} align="right">
        {items.map(item => (
          <button key={item.label} type="button" role="menuitem" disabled={!!item.disabledReason} title={item.disabledReason ?? undefined}
            onClick={() => { setOpen(false); item.onSelect(); }}
            className="v2-hover flex w-full items-center rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-v2-base text-[var(--v2-text-2)] disabled:opacity-45">
            {item.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}
