// One tab bar joined to its pane: the active tab wears the pane's background, an accent line
// on top and no bottom border, so it reads as part of the pane below (#14241).
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

export type TabSpec<T extends string = string> = {
  /** Matched against activeId and passed to onSelect and onClose. */
  id: T;
  label: string;
  title?: string;
  /** The tab button's DOM id, for a panel that links back via aria-labelledby. */
  buttonId?: string;
  /** The id of the panel this tab controls. */
  controls?: string;
  /** Avatar or icon before the label. */
  leading?: ReactNode;
  /** Small trailing sub label: a status word or a count. */
  sub?: ReactNode;
  /** Show a close button; the bar's onClose receives the tab's id. */
  close?: boolean;
  closeLabel?: string;
  /** The dirty dot, titled "Unsaved changes". */
  dirty?: boolean;
};

export type TabsProps<T extends string> = {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabSpec<T>[];
  activeId: T | null | undefined;
  onSelect: (id: T) => void;
  /** Without it no close button renders, even on tabs marked close. */
  onClose?: (id: T) => void;
  /** The pane background token: the active tab wears it and covers the bar's bottom border. */
  pane: string;
  /** Node before the tabs, e.g. a reveal-sidebar button. */
  lead?: ReactNode;
  /** Actions right beside the tabs, e.g. an offline count or an add button. */
  actions?: ReactNode;
  /** Far-right actions after the flexible gap. */
  end?: ReactNode;
  /** Extra classes for the strip: its height, padding or background. */
  barClassName?: string;
};

export function Tabs<T extends string>(p: TabsProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const key = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const count = p.tabs.length;
    const to = e.key === "ArrowRight" ? (i + 1) % count : e.key === "ArrowLeft" ? (i - 1 + count) % count : -1;
    const next = to >= 0 ? p.tabs[to] : undefined;
    if (!next) return;
    e.preventDefault();
    p.onSelect(next.id);
    buttons.current[to]?.focus();
  };
  const tabbable = Math.max(p.tabs.findIndex(t => t.id === p.activeId), 0);
  return (
    <div className={`flex min-w-0 shrink-0 items-stretch gap-1.5 border-b border-[var(--v2-edge)] bg-[var(--v2-chrome)] ${p.barClassName ?? ""}`}>
      {p.lead && <div className="flex shrink-0 items-center">{p.lead}</div>}
      <div role="tablist" aria-label={p.label} className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden pt-1">
        {p.tabs.map((t, i) => {
          const on = t.id === p.activeId;
          return (
            <div key={t.id} className={`flex shrink-0 items-center rounded-t-md border-x border-t-2 ${on ? "border-x-[var(--v2-edge)] border-t-[var(--v2-accent)]" : "border-x-transparent border-t-transparent hover:bg-[var(--v2-raised)]"}`}
              style={on ? { background: p.pane, borderBottom: `1px solid ${p.pane}`, marginBottom: "-1px" } : undefined}>
              <button type="button" role="tab" id={t.buttonId} aria-selected={on} aria-controls={t.controls} title={t.title}
                tabIndex={i === tabbable ? 0 : -1} ref={el => { buttons.current[i] = el; }}
                onClick={() => p.onSelect(t.id)} onKeyDown={e => key(e, i)}
                className={`flex h-full min-w-0 items-center gap-1.5 border-0 px-3 py-1.5 text-v2-body font-medium ${on ? "text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
                {t.leading}
                <span className="max-w-[160px] truncate">{t.label}</span>
                {t.sub}
                {t.dirty && <span title="Unsaved changes" aria-label="Unsaved changes" role="img" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--v2-accent)]" />}
              </button>
              {t.close && p.onClose && (
                <IconButton label={t.closeLabel ?? `Close ${t.label}`} title={t.closeLabel ?? "Close tab"} size={18} onClick={() => p.onClose?.(t.id)}>
                  <X size={11} aria-hidden />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      {p.actions && <div className="flex shrink-0 items-center gap-1.5 self-center">{p.actions}</div>}
      <span className="flex-1" />
      {p.end && <div className="flex shrink-0 items-center gap-2">{p.end}</div>}
    </div>
  );
}
