// #14344: a group's header row: caret, sentence-case title, count, and text actions that only show on hover.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export type HeaderAction = {
  label: string;
  onClick: () => void;
  title?: string;
  /** disables the action and says why */
  disabledReason?: string | null;
};

export type GroupHeaderProps = {
  /** the persistence and test key: data-section-toggle */
  section: string;
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: HeaderAction[];
  /** a trailing control such as a menu button, shown with the actions */
  menu?: ReactNode;
  controls?: string;
};

export function GroupHeader({ section, title, count, open, onToggle, actions = [], menu, controls }: GroupHeaderProps) {
  return (
    <div className="group flex h-[26px] shrink-0 items-center pr-2">
      <button type="button" aria-expanded={open} aria-controls={controls} data-section-toggle={section}
        title={open ? `Hide ${title}` : `Show ${title}`} onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent pl-2 pr-0 text-left text-v2-small font-semibold text-[var(--v2-text-2)]">
        <ChevronRight size={8} aria-hidden className="shrink-0"
          style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform var(--v2-dur-1) var(--v2-ease)" }} />
        <span className="truncate">{title}</span>
        {count === undefined ? null : <span data-count className="v2-mono shrink-0 font-normal text-[var(--v2-muted)]">{count}</span>}
      </button>
      <span className="invisible flex shrink-0 items-center gap-2 group-hover:visible group-focus-within:visible">
        {actions.map(a => (
          <button key={a.label} type="button" title={a.disabledReason ?? a.title} disabled={!!a.disabledReason} onClick={a.onClick}
            className="border-0 bg-transparent p-0 text-v2-small text-[var(--v2-link)] disabled:opacity-45">{a.label}</button>
        ))}
        {menu}
      </span>
    </div>
  );
}
