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
  /** #14344: equal-width small segments across the row, with a thumb that slides to the choice. */
  fill?: boolean;
};

function FilledSeg<T extends string>({ label, options, value, onChange }: SegProps<T>) {
  const at = Math.max(0, options.findIndex(o => o.value === value));
  return (
    <div role="group" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
      className="relative grid rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-[2px]">
      <span aria-hidden data-seg-thumb className="absolute inset-y-[2px] left-[2px] rounded-md bg-[var(--v2-hover)]"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${at * 100}%)`, transition: "transform var(--v2-dur-2) var(--v2-ease)" }} />
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title}
          onClick={() => onChange(o.value)}
          className={`relative inline-flex items-center justify-center gap-1.5 rounded-md border-0 bg-transparent py-1 text-v2-small font-medium ${
            o.value === value ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>(p: SegProps<T>) {
  if (p.fill) return <FilledSeg {...p} />;
  const { label, options, value, onChange } = p;
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
