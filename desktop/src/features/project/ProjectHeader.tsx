// The project screen header, restructured not squeezed (#5616): two rows, each with one job.
// Row 1 (identity): name and stats share a baseline and TRUNCATE, always one line tall, never
// stacking. Row 2 (chrome): lens tabs own the left and scroll rather than clip; search/filter
// live right and shrink FIRST. One component here keeps BOARD/FEED/CHAT from drifting apart.
import type { ReactNode } from "react";

const LENSES = ["workspace", "code", "board", "feed", "bus"] as const;
export type Lens = (typeof LENSES)[number];
/** Lens values that may still arrive from a pane opened before the v3 rename (#5814). They are
 *  not tabs — AppShell routes them to the Code surface; nothing here renders them. */
export type LensCompat = Lens | "files" | "review";

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
      {/* WRAPPING row, not a shrinking one: shrink-0 tabs beside flex-1 tools let the two
          OVERLAP once the row overflowed (operator screenshot #2, 2026-08-30 — "Review" under
          the filter). Wrap puts the tools on their own line at narrow widths instead; the seg
          itself scrolls only as the very last resort. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="tr-seg min-w-0 max-w-full overflow-x-auto">
          {LENSES.map(l => (
            <button key={l} data-on={lens === l} onClick={() => onLens(l)} className="shrink-0">
              {l.charAt(0).toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
        {children && (
          <div className="ml-auto flex min-w-0 items-center gap-2.5">{children}</div>
        )}
      </div>
    </header>
  );
}
