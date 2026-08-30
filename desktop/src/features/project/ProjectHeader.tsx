// The one way a project screen opens — restructured, not squeezed (#5616). The old header put
// title, stats, search, filter and six lens tabs in ONE flex row with a shrink-0 right side; at
// laptop widths with the chat docked, the tabs clipped off the edge and the stats stacked into
// a vertical mangle (operator screenshot, 2026-08-30). Now each row has one job:
//   row 1 — identity: the name and its quiet stats line share a baseline and TRUNCATE; the row
//           is one line tall at every width, no stacking, ever.
//   row 2 — working chrome: the lens tabs own the left and never clip invisibly (they scroll as
//           a last resort); the tools (search/filter) live right and shrink FIRST.
// Owning this in one component is what keeps BOARD/FEED/CHAT from drifting apart — the
// whack-a-mole lesson, structural.
import type { ReactNode } from "react";

const LENSES = ["workspace", "files", "board", "feed", "bus", "review"] as const;
export type Lens = (typeof LENSES)[number];

export function ProjectHeader({ project, sub, lens, onLens, children }: {
  project: string; sub: ReactNode; lens: Lens; onLens: (l: Lens) => void; children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2 px-8 pt-5 pb-3">
      <div className="flex min-w-0 items-baseline gap-3 overflow-hidden">
        <h1 className="tr-page-title max-w-[50%] shrink-0 truncate">{project}</h1>
        <div className="tr-page-sub min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-x-2 overflow-hidden whitespace-nowrap">{sub}</div>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <div className="tr-seg shrink-0 overflow-x-auto">
          {LENSES.map(l => (
            <button key={l} data-on={lens === l} onClick={() => onLens(l)}>
              {l.charAt(0).toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
        {children && (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">{children}</div>
        )}
      </div>
    </header>
  );
}
