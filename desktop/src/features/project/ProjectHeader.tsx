// The one way a project screen opens: title a human would say, one quiet line under it, and the
// lens switcher top-right. Owning this in one component is what keeps BOARD/FEED/CHAT from
// drifting apart — the whack-a-mole lesson, structural this time.
import type { ReactNode } from "react";

const LENSES = ["board", "feed", "chat"] as const;
export type Lens = (typeof LENSES)[number];

export function ProjectHeader({ project, sub, lens, onLens, children }: {
  project: string; sub: ReactNode; lens: Lens; onLens: (l: Lens) => void; children?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 px-8 pt-6 pb-4">
      <div className="min-w-0">
        <h1 className="tr-page-title truncate">{project}</h1>
        <p className="tr-page-sub">{sub}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3 pt-1">
        {children}
        <div className="tr-seg">
          {LENSES.map(l => (
            <button key={l} data-on={lens === l} onClick={() => onLens(l)}>
              {l.charAt(0).toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
