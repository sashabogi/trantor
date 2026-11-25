// The left rail from the Workspace artboard: fleet screens, active-project tiles, settings (#v2-F).
import { useState, type ReactNode } from "react";
import { Blocks, Bot, ChevronsLeft, ChevronsRight, FolderOpen, Gauge, Inbox, LayoutDashboard, MessagesSquare, Settings } from "lucide-react";
import { ProjectTile } from "../ui/ProjectTile";
import { PRESENCE_COLOR } from "../ui/identity";
import { isLensScreen, type Navigate, type Screen } from "../routes";
import { MODE_CONFIG, useShellMode } from "./shellMode";

function readExpanded(key: string) {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}

function RailButton({ label, title, active, onClick, badge, dot, expanded, className = "", children }: {
  label: string; title: string; active?: boolean; onClick: () => void; badge?: number; dot?: boolean;
  expanded: boolean; className?: string; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={expanded ? undefined : title} aria-current={active ? "page" : undefined} onClick={onClick}
      className={`relative flex h-10 shrink-0 items-center rounded-[10px] border-0 ${expanded ? "w-full gap-2.5 px-2" : "w-10 justify-center"} ${
        active ? "bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]" : "bg-transparent text-[var(--v2-muted)] hover:bg-[var(--v2-raised)] hover:text-[var(--v2-text)]"} ${className}`}>
      <span className="flex w-[26px] shrink-0 items-center justify-center">{children}</span>
      {expanded && <span className="min-w-0 flex-1 truncate text-left text-[13px]">{title}</span>}
      {!!badge && (
        <span data-badge className={`${expanded ? "ml-auto" : "absolute top-[5px] right-1"} flex h-[14px] min-w-[14px] items-center justify-center rounded-[7px] bg-[var(--v2-accent)] px-[3px] text-[9px] font-bold text-[var(--v2-ink)]`}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {expanded && dot && <span data-dot="needs-you" className="ml-auto h-2 w-2 shrink-0 rounded-full" style={{ background: PRESENCE_COLOR["needs-you"] }} />}
    </button>
  );
}

export type RailProps = {
  screen: Screen;
  project: string;
  /** Projects with live sessions; the active project is always shown. */
  live: string[];
  unread: number;
  needsYou: number;
  onNavigate: Navigate;
};

const FLEET: { screen: Screen; label: string; icon: ReactNode }[] = [
  { screen: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} aria-hidden /> },
  { screen: "inbox", label: "Inbox", icon: <Inbox size={18} aria-hidden /> },
  { screen: "messages", label: "Messages", icon: <MessagesSquare size={18} aria-hidden /> },
  { screen: "agents", label: "Agents", icon: <Bot size={18} aria-hidden /> },
  { screen: "usage", label: "Usage and costs", icon: <Gauge size={18} aria-hidden /> },
  { screen: "extensions", label: "Extensions", icon: <Blocks size={18} aria-hidden /> },
];

export function Rail({ screen, project, live, unread, needsYou, onNavigate }: RailProps) {
  // #14070: each mode keeps its own choice, so Developer starts on icons whatever Orchestrator shows.
  const { railKey, landing } = MODE_CONFIG[useShellMode()];
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const expanded = picked[railKey] ?? readExpanded(railKey);
  const tiles = [...new Set([project, ...live].filter(Boolean))].slice(0, 6);
  const inProject = isLensScreen(screen);
  const toggle = () => {
    const next = !expanded;
    try { localStorage.setItem(railKey, String(next)); } catch {}
    setPicked(current => ({ ...current, [railKey]: next }));
  };
  const action = expanded ? "Collapse the sidebar" : "Expand the sidebar";
  return (
    <nav aria-label="Primary" data-expanded={expanded} className={`flex ${expanded ? "w-[200px] items-stretch px-2" : "w-[58px] items-center"} shrink-0 flex-col gap-1 overflow-y-auto overflow-x-hidden border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] pt-2.5`}>
      {FLEET.map(f => {
        const isInbox = f.screen === "inbox";
        return (
          <RailButton key={f.screen} label={isInbox && unread ? `Inbox, ${unread} unread` : f.label} title={f.label} expanded={expanded}
            active={screen === f.screen} badge={isInbox ? unread : undefined} onClick={() => onNavigate(f.screen)}>
            {f.icon}
          </RailButton>
        );
      })}
      <div aria-hidden className="my-1.5 h-px w-[26px] shrink-0 self-center bg-[var(--v2-edge)]" />
      {tiles.map(p => {
        const open = inProject && p === project;
        const needs = p === project && !!needsYou;
        return (
          <RailButton key={p} label={open ? `${p}, open` : p} title={p} active={open} expanded={expanded} dot={needs} onClick={() => onNavigate(landing, p)}>
            <ProjectTile name={p} size={26} dot={!expanded && needs ? "needs-you" : undefined} />
          </RailButton>
        );
      })}
      <RailButton label="All projects" title="All projects" active={screen === "projects"} expanded={expanded} onClick={() => onNavigate("projects")}>
        <FolderOpen size={18} aria-hidden />
      </RailButton>
      <RailButton label="Settings" title="Settings" active={screen === "settings"} expanded={expanded} onClick={() => onNavigate("settings")} className="mt-auto">
        <Settings size={18} aria-hidden />
      </RailButton>
      <button type="button" aria-label={action} title={action} onClick={toggle}
        className={`mb-2.5 flex h-10 shrink-0 items-center rounded-[10px] border-0 bg-transparent text-[var(--v2-muted)] hover:bg-[var(--v2-raised)] hover:text-[var(--v2-text)] ${expanded ? "w-full gap-2.5 px-2" : "w-10 justify-center"}`}>
        <span className="flex w-[26px] shrink-0 items-center justify-center">
          {expanded ? <ChevronsLeft size={18} aria-hidden /> : <ChevronsRight size={18} aria-hidden />}
        </span>
        {expanded && <span className="min-w-0 flex-1 truncate text-left text-[13px]">{action}</span>}
      </button>
    </nav>
  );
}
