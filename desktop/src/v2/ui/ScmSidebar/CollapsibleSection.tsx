// One collapsible group of the source control sidebar (#14044): a GroupHeader and a body that sits in the
// column's one scroller, the open/closed choice remembered per section in localStorage.
// #14344: no inner scroller; groups that are history, not work, start folded.
import { useId, useState, type ReactNode } from "react";
import { GroupHeader, type HeaderAction } from "../GroupHeader";
import { readScmSectionOpen, writeScmSectionOpen } from "./sectionState";

export type CollapsibleSectionProps = {
  /** persistence key suffix: trantor.v2.scm.<section> */
  section: string;
  title: string;
  count?: number;
  /** hover-only text actions in the header */
  actions?: HeaderAction[];
  /** a trailing control such as a menu button */
  menu?: ReactNode;
  /** the state before the operator chooses; folded groups pass false */
  defaultOpen?: boolean;
  children: ReactNode;
};

export function CollapsibleSection({ section, title, count, actions, menu, defaultOpen = true, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => readScmSectionOpen(section, defaultOpen));
  const id = useId();
  const toggle = () => setOpen(o => {
    const next = !o;
    writeScmSectionOpen(section, next);
    return next;
  });
  return (
    <section aria-label={title} data-section={section} className="flex shrink-0 flex-col border-t border-[var(--v2-edge-soft)] first:border-t-0">
      <GroupHeader section={section} title={title} count={count} open={open} onToggle={toggle} actions={actions} menu={menu} controls={id} />
      {open && <div id={id} data-section-body={section} className="flex flex-col pb-1">{children}</div>}
    </section>
  );
}
