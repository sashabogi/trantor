// The composer's two chips open menus that show every option with what it does (#13984 drill: a click used to cycle blind).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Lock, ShieldCheck, Zap } from "lucide-react";

export type Choice = {
  value: string;
  label: string;
  /** One line on what picking it does. */
  description?: string;
  icon?: "lock" | "shield" | "zap";
  /** Amber: the option that removes a safeguard. */
  tone?: "warn";
};

const PILL = "inline-flex min-w-0 items-center rounded-full border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] text-[11.5px] font-medium";

export function ChoiceIcon({ choice, size = 13 }: { choice?: Choice; size?: number }) {
  if (choice?.icon === "zap") return <Zap size={size} aria-hidden />;
  if (choice?.icon === "shield") return <ShieldCheck size={size} aria-hidden />;
  return <Lock size={size} aria-hidden />;
}

/** A chip that opens a menu above the composer; without a menu it is a plain label, never a dead button. */
export function ChipMenu({ label, title, group, className = "", chip, menuLabel, children }: {
  label: string; title: string; group: string; className?: string; chip: ReactNode; menuLabel: string;
  children?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (!children) {
    return <span data-group={group} aria-label={label} title={title} className={`${PILL} ${className}`}>{chip}</span>;
  }
  return (
    <div ref={ref} data-group={group} className={`min-w-0 ${className.includes("shrink") ? "shrink" : "flex-none"}`}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title}
        onClick={() => setOpen(o => !o)} className={`${PILL} v2-hover max-w-full ${className}`}>
        {chip}
        <ChevronDown size={10} aria-hidden className="ml-[3px] flex-none text-[var(--v2-muted)]" style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && (
        <div role="menu" aria-label={menuLabel}
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 max-h-[60vh] w-[min(320px,100%)] overflow-y-auto rounded-[12px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1.5 shadow-[0_-12px_32px_rgba(0,0,0,0.5)]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--v2-muted)] uppercase">{children}</div>;
}

/** One option row: icon, name, what it does, and a check on the current one. */
export function ChoiceRow({ choice, current, onPick, leading }: {
  choice: Choice; current: boolean; onPick: () => void; leading?: ReactNode;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={current} onClick={onPick}
      className={`v2-hover flex w-full items-start gap-2 rounded-[8px] border-0 px-2 py-1.5 text-left ${current ? "bg-[var(--v2-raised)]" : "bg-transparent"}`}>
      <span className={`mt-[2px] flex-none ${choice.tone === "warn" ? "text-[var(--v2-warn)]" : "text-[var(--v2-text-2)]"}`}>{leading}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-[var(--v2-text)]">{choice.label}</span>
        {choice.description && <span className="block text-[11.5px] leading-snug text-[var(--v2-muted)]">{choice.description}</span>}
      </span>
      {current && <Check size={13} aria-hidden className="mt-[3px] flex-none text-[var(--v2-accent)]" />}
    </button>
  );
}

/** Effort as a row of named levels, the current one outlined. */
export function LevelPills({ label, choices, value, onPick }: {
  label: string; choices: readonly Choice[]; value: string | null; onPick: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 px-2 pt-1 pb-1.5">
      {choices.map(c => (
        <button key={c.value} type="button" role="radio" aria-checked={c.value === value} title={c.description} onClick={() => onPick(c.value)}
          className={`v2-hover rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium ${
            c.value === value ? "border-[var(--v2-accent)] bg-[var(--v2-accent-soft)] text-[var(--v2-text)]" : "border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-text-2)]"}`}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
