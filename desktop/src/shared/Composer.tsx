// The composer as a designed object — Buzz's lesson: the message box is the most-touched surface
// in a conversation UI, so it gets a real surface, not a bare input strip. One composer for every
// conversation surface (project chat, inbox) so they cannot drift.
import type { ReactNode } from "react";

export function Composer({ value, onChange, onSend, placeholder, busy, disabled, left }: {
  value: string; onChange: (v: string) => void; onSend: () => void;
  placeholder: string; busy?: boolean; disabled?: boolean; left?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-tr-edge)] bg-white/[0.03] p-2">
      <div className="flex items-end gap-2">
        {left}
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-[var(--color-tr-muted)]"
        />
        <button
          onClick={onSend}
          disabled={disabled || busy}
          title="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-tr-doing)] text-white transition-opacity disabled:opacity-30">
          {busy ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}
