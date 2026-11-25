// One collapsible section of the source control sidebar (#14044): a chevron header with badge and
// row actions, and the open/closed choice remembered per section in localStorage.
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { readScmSectionOpen, writeScmSectionOpen } from "./sectionState";

export type CollapsibleSectionProps = {
  /** persistence key suffix: trantor.v2.scm.<section> */
  section: string;
  title: string;
  /** a count beside the title */
  badge?: ReactNode;
  /** header-row actions (kept outside the toggle button so they stay clickable) */
  actions?: ReactNode;
  children: ReactNode;
};

export function CollapsibleSection({ section, title, badge, actions, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => readScmSectionOpen(section));
  const id = useId();
  const toggle = () => setOpen(o => {
    const next = !o;
    writeScmSectionOpen(section, next);
    return next;
  });
  return (
    <section aria-label={title} data-section={section} className="border-b border-[var(--v2-edge)]">
      <div className="flex items-center pr-2">
        <button type="button" aria-expanded={open} aria-controls={id} data-section-toggle={section}
          title={open ? `Collapse ${title}` : `Expand ${title}`} onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-3 py-2 text-left text-[11.5px] font-semibold text-[var(--v2-text-2)] hover:bg-[var(--v2-raised)]">
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span className="shrink-0">{title}</span>
          {badge}
        </button>
        {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
      </div>
      {open && <div id={id} data-section-body={section}>{children}</div>}
    </section>
  );
}
