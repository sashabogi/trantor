// One dial row of the Autonomy page: name, default/changed tag, help, provenance, Off/On (#13994).
import { Chip } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { Toggle } from "../../ui/Toggle";

export type DialChoice = { value: string; label: string };

export type DialRowProps = {
  label: string;
  why: string;
  choices: readonly DialChoice[];
  value: string;
  changed: boolean;
  /** Set when an outer dial is held shut by the dial it depends on. */
  blockedNote?: string | null;
  provenance?: string | null;
  note?: string | null;
  busy?: boolean;
  onPick: (value: string) => void;
};

/** An off/on pair is a boolean dial: it gets a real switch, not a segmented pick (#13984 drill). */
const isBoolean = (choices: readonly DialChoice[]) => choices.length === 2 && choices[0]?.value === "off" && choices[1]?.value === "on";

export function DialRow({ label, why, choices, value, changed, blockedNote, provenance, note, busy, onPick }: DialRowProps) {
  const locked = !!blockedNote;
  return (
    <div data-dial={label} className="flex items-start gap-4 border-b border-[var(--v2-edge)] px-[14px] py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--v2-text)]">{label}</span>
          <Chip tone={changed ? "info" : "neutral"}>{changed ? "changed" : "default"}</Chip>
          <IconButton label={`Help for ${label}`} title={why} size={18}>
            <span aria-hidden="true" className="text-[10px] font-semibold">?</span>
          </IconButton>
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--v2-muted)]">{why}</div>
        {blockedNote && <div className="mt-1 text-[11.5px] text-[var(--v2-warn)]">{blockedNote}</div>}
        {note && <div className="mt-1 text-[11.5px] text-[var(--v2-warn)]">{note}</div>}
        {provenance && <div className="v2-mono mt-1 text-[11px] text-[var(--v2-muted)]">{provenance}</div>}
      </div>
      {isBoolean(choices)
        ? <Toggle label={label} on={value === "on"} disabled={locked || !!busy} title={blockedNote ?? undefined}
            onToggle={() => onPick(value === "on" ? "off" : "on")} />
        : (
      <div role="radiogroup" aria-label={label} title={blockedNote ?? undefined}
        className="flex shrink-0 rounded-[9px] border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-[2px]">
        {choices.map(c => {
          const on = c.value === value;
          return (
            <button key={c.value} type="button" role="radio" aria-checked={on} disabled={locked || busy}
              onClick={() => { if (!on) onPick(c.value); }}
              className={`rounded-[7px] border-0 px-[11px] py-[5px] text-[12px] font-medium disabled:opacity-45 ${
                on ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
              {c.label}
            </button>
          );
        })}
      </div>
        )}
    </div>
  );
}
