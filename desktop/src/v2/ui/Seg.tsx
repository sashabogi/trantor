import type { ReactNode } from "react";

export type SegOption<T extends string> = {
  value: T; label: string; icon?: ReactNode; title?: string;
  /** Shown but cannot be picked; the title says why (#14070). */
  disabled?: boolean;
};

export type SegProps<T extends string> = {
  /** Accessible name of the group, e.g. "Mode". */
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
};

export function Seg<T extends string>({ label, options, value, onChange }: SegProps<T>) {
  return (
    <div role="group" aria-label={label}
      className="flex shrink-0 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-[2px]">
      {options.map(o => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} aria-disabled={o.disabled || undefined} title={o.title}
            onClick={() => { if (!o.disabled) onChange(o.value); }}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border-0 px-[11px] py-[5px] text-v2-body font-medium ${
              o.disabled ? "cursor-not-allowed bg-transparent text-[var(--v2-muted)] opacity-50"
                : on ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}
