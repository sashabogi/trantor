import type { ReactNode } from "react";
import { Check, Circle, CircleHelp, MessagesSquare, Shield, Smartphone, Trash2, TriangleAlert } from "lucide-react";
import { ProjectTile } from "../../index";
import { isStale, itemMatches, type InboxFilter, type InboxItem } from "./model";

const FILTERS: { id: InboxFilter; label: string; icon: ReactNode }[] = [
  { id: "needs", label: "Needs you", icon: <Circle size={13} aria-hidden /> },
  { id: "questions", label: "Questions", icon: <CircleHelp size={13} aria-hidden /> },
  { id: "proposals", label: "Proposals", icon: <Shield size={13} aria-hidden /> },
  { id: "collisions", label: "Collisions", icon: <TriangleAlert size={13} aria-hidden /> },
  { id: "stale", label: "Stale, safe to clear", icon: <Trash2 size={13} aria-hidden /> },
  { id: "answered", label: "Answered", icon: <Check size={13} aria-hidden /> },
];

function FilterButton({ id, label, icon, count, active, onClick }: {
  id: InboxFilter; label: string; icon: ReactNode; count: number; active: boolean; onClick: (id: InboxFilter) => void;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={() => onClick(id)}
      className={`v2-hover flex w-full items-center gap-2 rounded-md border-0 px-2.5 py-1.5 text-left text-v2-base ${
        active ? "bg-[var(--v2-raised)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-text-2)]"}`}>
      <span className={id === "needs" ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"}>{icon}</span>
      <span className="flex-1">{label}</span><span className="text-v2-small text-[var(--v2-muted)]">{count}</span>
    </button>
  );
}

export function InboxFilters({ items, settled, filter, project, onFilter, onProject, onMessages }: {
  items: InboxItem[];
  settled: ReadonlySet<string>;
  filter: InboxFilter;
  project: string;
  onFilter: (filter: InboxFilter) => void;
  onProject: (project: string) => void;
  onMessages: () => void;
}) {
  const waiting = items.filter(item => !settled.has(item.key) && !isStale(item));
  const projects = [...new Set(waiting.map(item => item.project).filter(Boolean))].sort();
  const needs = waiting.length;
  return (
    <aside aria-label="Inbox filters" className="flex w-[232px] shrink-0 flex-col gap-0.5 border-r border-[var(--v2-edge)] bg-[var(--v2-bg)] p-2 pt-3.5">
      <div className="flex items-baseline gap-2 px-1.5 pb-2.5">
        <h1 className="m-0 text-v2-heading font-[650]">Inbox</h1>
        <span className="text-v2-body text-[var(--v2-warn)]">{needs} need you</span>
      </div>
      {FILTERS.slice(0, 4).map(row => (
        <FilterButton key={row.id} {...row} active={filter === row.id && !project} onClick={onFilter}
          count={items.filter(item => itemMatches(item, row.id, settled)).length} />
      ))}
      <div aria-hidden className="mx-1.5 my-2 h-px bg-[var(--v2-edge)]" />
      {FILTERS.slice(4).map(row => (
        <FilterButton key={row.id} {...row} active={filter === row.id && !project} onClick={onFilter}
          count={items.filter(item => itemMatches(item, row.id, settled)).length} />
      ))}
      <button type="button" onClick={onMessages} className="v2-hover flex items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-v2-base text-[var(--v2-text-2)]">
        <MessagesSquare size={13} aria-hidden /><span className="flex-1">All bus conversations</span>
      </button>
      <div className="px-2.5 pt-3.5 pb-1.5 text-v2-small font-semibold tracking-[0.08em] text-[var(--v2-muted)]">PROJECTS</div>
      {projects.map(name => (
        <button key={name} type="button" aria-pressed={project === name} onClick={() => onProject(project === name ? "" : name)}
          className={`v2-hover flex items-center gap-2 rounded-md border-0 px-2.5 py-1.5 text-left text-v2-base ${project === name ? "bg-[var(--v2-raised)]" : "bg-transparent"}`}>
          <ProjectTile name={name} size={16} /><span className="min-w-0 flex-1 truncate text-[var(--v2-text-2)]">{name}</span>
          <span className="text-v2-small text-[var(--v2-muted)]">{waiting.filter(item => item.project === name).length}</span>
        </button>
      ))}
      <div className="flex-1" />
      <div className="mx-1.5 flex gap-1.5 rounded-lg border border-[var(--v2-edge)] p-2.5 text-v2-small leading-[1.45] text-[var(--v2-muted)]">
        <Smartphone className="shrink-0" size={12} aria-hidden />Same list on your phone. Answer either place; the other updates.
      </div>
    </aside>
  );
}
