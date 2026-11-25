// One collapsible section of the source control sidebar (#14044): a chevron header with badge and
// row actions, the open/closed choice remembered per section in localStorage. #14058: the section
// owns its scrolling so every header stays on screen: "fill" takes the space the others leave
// (Files), "content" sizes to its content and stops at 40% of the column.
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { readScmSectionOpen, writeScmSectionOpen } from "./sectionState";

export type SectionSizing = "fill" | "content";

export type CollapsibleSectionProps = {
  /** persistence key suffix: trantor.v2.scm.<section> */
  section: string;
  title: string;
  /** a count beside the title */
  badge?: ReactNode;
  /** header-row actions (kept outside the toggle button so they stay clickable) */
  actions?: ReactNode;
  /** fill grows to the space the other sections leave; content stops at 40% of the column */
  sizing?: SectionSizing;
  children: ReactNode;
};

export function CollapsibleSection({ section, title, badge, actions, sizing = "content", children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => readScmSectionOpen(section));
  const id = useId();
  const toggle = () => setOpen(o => {
    const next = !o;
    writeScmSectionOpen(section, next);
    return next;
  });
  // Collapsed is only its header row, never squashed; open bodies scroll inside themselves.
  const spaceClass = !open ? "shrink-0" : sizing === "fill" ? "min-h-0 flex-1" : "max-h-[40%] min-h-0 shrink";
  return (
    <section aria-label={title} data-section={section} className={`flex min-h-0 flex-col border-b border-[var(--v2-edge)] ${spaceClass}`}>
      <div className="flex shrink-0 items-center pr-2">
        <button type="button" aria-expanded={open} aria-controls={id} data-section-toggle={section}
          title={open ? `Hide ${title}` : `Show ${title}`} onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-3 py-2 text-left text-[11.5px] font-semibold text-[var(--v2-text-2)] hover:bg-[var(--v2-raised)]">
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span className="truncate">{title}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </button>
        {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
      </div>
      {open && <div id={id} data-section-body={section}
        className={sizing === "fill" ? "min-h-0 flex-1 overflow-y-auto" : "min-h-0 overflow-y-auto"}>{children}</div>}
    </section>
  );
}
