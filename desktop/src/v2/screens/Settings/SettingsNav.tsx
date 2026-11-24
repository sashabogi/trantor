// The left nav: search box, then the artboard's four groups (#13994).
import { Search } from "lucide-react";
import { GROUPS, type SectionDef, type SectionId } from "./sections";

export type SettingsNavProps = {
  sections: readonly SectionDef[];
  active: SectionId;
  query: string;
  onQuery: (q: string) => void;
  onPick: (id: SectionId) => void;
};

export function SettingsNav({ sections, active, query, onQuery, onPick }: SettingsNavProps) {
  return (
    <aside aria-label="Settings sections" className="flex w-[260px] shrink-0 flex-col gap-3 overflow-auto border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] p-3">
      <h1 className="m-0 px-1 text-[20px] font-[650]">Settings</h1>
      <label htmlFor="settings-search" className="sr-only">Search settings</label>
      <div className="flex items-center gap-2 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2.5 py-1.5">
        <Search size={12} aria-hidden="true" className="text-[var(--v2-muted)]" />
        <input id="settings-search" type="text" placeholder="Search every setting" value={query} onChange={e => onQuery(e.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-[var(--v2-text)] outline-none" />
      </div>
      {GROUPS.map(g => {
        const items = sections.filter(s => s.group === g);
        if (!items.length) return null;
        return (
          <div key={g} role="group" aria-label={g} className="flex flex-col gap-0.5">
            <div className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-muted)]">{g}</div>
            {items.map(s => (
              <button key={s.id} type="button" data-section={s.id} aria-current={s.id === active ? "page" : undefined} onClick={() => onPick(s.id)}
                className={`flex flex-col items-start rounded-lg border-0 px-2.5 py-1.5 text-left ${s.id === active ? "bg-[var(--v2-raised)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-text-2)] hover:bg-[var(--v2-panel-2)]"}`}>
                <span className="text-[12.5px] font-medium">{s.label}</span>
                <span className="text-[11px] text-[var(--v2-muted)]">{s.desc}</span>
              </button>
            ))}
          </div>
        );
      })}
      {!sections.length && <p className="m-0 px-1 text-[12px] text-[var(--v2-muted)]">No setting matches that search.</p>}
    </aside>
  );
}
