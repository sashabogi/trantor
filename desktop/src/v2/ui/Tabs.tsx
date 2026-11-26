// One tab bar joined to its pane: the active tab wears the pane's background, an accent line
// on top and no bottom border, so it reads as part of the pane below (#14241).
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
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
  /** Stacked variant only: the second line, under the label. */
  line2?: ReactNode;
  /** Stacked variant only: shown in a fixed card above the tab after it has been hovered for a short rest. */
  hoverCard?: ReactNode;
  /** #14365: stacked variant only: the tab is just its leading mark (about 40px wide), named for assistive tech by ariaLabel. */
  iconOnly?: boolean;
  /** The tab's top edge colour (a seat's brand colour): full on the active tab, at ~70% on the rest. */
  topColor?: string;
  ariaLabel?: string;
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
  /** #14351: two-line tabs (label over line2), 120 to 220px wide, hover wash, optional hover card. */
  stacked?: boolean;
  /** Stacked and crowded: inactive tabs shrink to a shared narrow width and hide line 2. */
  crowded?: boolean;
};

const REST_MS = 400;

/** Calls show after the pointer has rested on the element for REST_MS; hide on leave. */
function useRest() {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  return { shown, props: {
    onPointerEnter: () => { clear(); timer.current = setTimeout(() => setShown(true), REST_MS); },
    onPointerLeave: () => { clear(); setShown(false); },
  } };
}

function StackedTab<T extends string>({ t, on, i, tabbable, p, buttons, onKeyNav }: {
  t: TabSpec<T>; on: boolean; i: number; tabbable: number; p: TabsProps<T>;
  buttons: MutableRefObject<Array<HTMLButtonElement | null>>; onKeyNav: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
}) {
  const rest = useRest();
  const box = useRef<HTMLDivElement | null>(null);
  const small = p.crowded && !on && !t.iconOnly;
  const rect = rest.shown && t.hoverCard ? box.current?.getBoundingClientRect() : undefined;
  const style: CSSProperties = t.iconOnly
    // #14365: icon tabs hold a full 64px seat astronaut (typing, tapping, waving), not just a head.
    ? { transitionDuration: "var(--v2-dur-1)", width: t.close ? 92 : 76 }
    : { transitionDuration: "var(--v2-dur-1)", minWidth: small ? 96 : 120, maxWidth: small ? 120 : 220 };
  if (on) Object.assign(style, { background: p.pane, borderBottom: `1px solid ${p.pane}`, marginBottom: "-1px" });
  // A plain #rrggbb softens to ~70% with an alpha byte; anything else is used as given.
  if (t.topColor) style.borderTopColor = on || !/^#[0-9a-f]{6}$/i.test(t.topColor) ? t.topColor : `${t.topColor}b3`;
  return (
    <div ref={box} {...rest.props} data-active={on || undefined}
      className={`relative flex shrink-0 items-center rounded-t-md border-x border-t-2 transition-colors ${on ? "border-x-[var(--v2-edge)] border-t-[var(--v2-accent)]" : "border-x-transparent border-t-transparent hover:bg-[var(--v2-row-hover)]"}`}
      style={style}>
      <button type="button" role="tab" id={t.buttonId} aria-selected={on} aria-controls={t.controls} aria-label={t.ariaLabel} title={t.title}
        tabIndex={i === tabbable ? 0 : -1} ref={el => { buttons.current[i] = el; }}
        onClick={() => p.onSelect(t.id)} onKeyDown={e => onKeyNav(e, i)}
        className={`flex h-full min-w-0 flex-1 items-center border-0 bg-transparent py-1 ${t.iconOnly ? "justify-center px-1" : "gap-2 px-2.5 text-left"}`}>
        {t.leading}
        {!t.iconOnly && <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-v2-body font-semibold ${on ? "text-[var(--v2-text)]" : "text-[var(--v2-text-2)]"}`}>{t.label}</span>
          {!small && t.line2 && <span className="truncate text-v2-small text-[var(--v2-muted)]">{t.line2}</span>}
        </span>}
        {!t.iconOnly && t.sub}
      </button>
      {t.close && p.onClose && (
        <IconButton label={t.closeLabel ?? `Close ${t.label}`} title={t.closeLabel ?? "Close tab"} size={18} onClick={() => p.onClose?.(t.id)}>
          <X size={11} aria-hidden />
        </IconButton>
      )}
      {rect && (
        <div role="tooltip" className="v2-hovercard pointer-events-none fixed z-40" style={{ left: rect.left, top: rect.bottom + 4 }}>{t.hoverCard}</div>
      )}
    </div>
  );
}

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
          if (p.stacked) return <StackedTab key={t.id} t={t} on={on} i={i} tabbable={tabbable} p={p} buttons={buttons} onKeyNav={key} />;
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
