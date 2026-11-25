// The frame both pickers share: a dimmed backdrop, one input, a list the arrow keys walk.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Kbd } from "../Kbd";

/** Selection and keys for a list of `count` rows; Enter calls `onPick` with the selected index. */
export function useListKeys(count: number, resetKey: string, onPick: (index: number) => void, onClose: () => void) {
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [resetKey]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, count - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && count > 0) { e.preventDefault(); onPick(Math.min(sel, count - 1)); }
  };
  return { sel, setSel, onKeyDown };
}

export function Picker({ label, placeholder, query, onQuery, onKeyDown, onClose, children }: {
  label: string; placeholder: string; query: string; onQuery: (q: string) => void;
  onKeyDown: (e: KeyboardEvent) => void; onClose: () => void; children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={label} className="w-[560px] max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-[var(--v2-edge)] px-4 py-3">
          <Search size={14} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
          <input ref={input} aria-label={label} value={query} onChange={e => onQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder={placeholder} className="w-full border-0 bg-transparent text-[13.5px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
          <Kbd>esc</Kbd>
        </div>
        {children}
      </div>
    </div>
  );
}

export const ROW = "flex w-full items-center gap-2.5 border-0 px-4 py-2 text-left text-[12.5px] text-[var(--v2-text)]";
export const rowTone = (selected: boolean) => (selected ? "bg-[var(--v2-raised)]" : "bg-transparent");
export const NOTE = "px-4 py-3 text-[12.5px] text-[var(--v2-muted)]";
