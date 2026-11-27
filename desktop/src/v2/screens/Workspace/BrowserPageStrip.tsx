// The page strip (artboard D, #14516): one tab per open page, only with two or more; a page an agent
// drives names its driver; the last page closing leaves Nothing open. close -> browser_close_page,
// select -> browser_select_page, + -> browser_new_page.
import { Plus, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { pageLabel, type BrowserPage } from "./browserModel";

export function BrowserPageStrip({ pages, activePage, onSelect, onClose, onNew }: {
  pages: readonly BrowserPage[];
  activePage: string;
  onSelect: (page: string) => void;
  onClose: (page: string) => void;
  onNew: () => void;
}) {
  return (
    <div role="tablist" aria-label="Pages" className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] px-1.5">
      {pages.map(p => {
        const on = p.id === activePage;
        const label = pageLabel(p);
        return (
          <div key={p.id} data-active={on || undefined}
            className={`flex h-6 max-w-[220px] shrink items-center gap-0.5 overflow-hidden rounded-md ${on ? "bg-[var(--v2-raised)]" : "v2-hover bg-transparent"}`}>
            <button type="button" role="tab" aria-selected={on} title={p.title || p.url || label}
              onClick={() => onSelect(p.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-2.5 text-left text-v2-small">
              <span className={`v2-mono truncate ${on ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)]"}`}>{label}</span>
              {p.driver && <span className="truncate text-[var(--v2-accent)]">· {p.driver.label}</span>}
            </button>
            <IconButton label={`Close ${label}`} title={`Close ${label}`} size={16} onClick={() => onClose(p.id)}>
              <X size={10} aria-hidden />
            </IconButton>
          </div>
        );
      })}
      <IconButton label="New page" title="Open a new page" size={24} onClick={onNew}><Plus size={12} aria-hidden /></IconButton>
    </div>
  );
}
