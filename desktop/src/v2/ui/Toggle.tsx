export type ToggleProps = {
  label: string;
  on: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
};

export function Toggle({ label, on, disabled = false, title, onToggle }: ToggleProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span data-switch-state className={`w-6 text-right text-v2-body font-medium ${on ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)]"}`}>{on ? "On" : "Off"}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} title={title ?? (on ? "Turn off" : "Turn on")}
        disabled={disabled} onClick={onToggle}
        className="relative h-[20px] w-[36px] rounded-full border-0 p-0 transition-colors disabled:opacity-45"
        style={{ background: on ? "var(--v2-accent)" : "var(--v2-track)" }}>
        <span aria-hidden className="absolute top-[2px] h-[16px] w-[16px] rounded-full bg-[var(--v2-knob)] transition-all"
          style={{ left: on ? 18 : 2 }} />
      </button>
    </div>
  );
}
