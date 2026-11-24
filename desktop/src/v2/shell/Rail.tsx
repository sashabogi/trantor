// The 58px left rail from the Workspace artboard: fleet screens, active-project tiles, settings (#v2-F).
import type { ReactNode } from "react";
import { Blocks, Bot, FolderOpen, Gauge, Inbox, LayoutDashboard, MessagesSquare, Settings } from "lucide-react";
import { ProjectTile } from "../ui/ProjectTile";
import { isLensScreen, type Navigate, type Screen } from "../routes";

function RailButton({ label, title, active, onClick, badge, className = "", children }: {
  label: string; title: string; active?: boolean; onClick: () => void; badge?: number; className?: string; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={title} aria-current={active ? "page" : undefined} onClick={onClick}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border-0 ${
        active ? "bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]" : "bg-transparent text-[var(--v2-muted)] hover:bg-[var(--v2-raised)] hover:text-[var(--v2-text)]"} ${className}`}>
      {children}
      {!!badge && (
        <span data-badge className="absolute top-[5px] right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-[7px] bg-[var(--v2-accent)] px-[3px] text-[9px] font-bold text-[var(--v2-ink)]">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
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
  const tiles = [...new Set([project, ...live].filter(Boolean))].slice(0, 6);
  const inProject = isLensScreen(screen);
  return (
    <nav aria-label="Primary" className="flex w-[58px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] pt-2.5">
      {FLEET.map(f => {
        const isInbox = f.screen === "inbox";
        return (
          <RailButton key={f.screen} label={isInbox && unread ? `Inbox, ${unread} unread` : f.label} title={f.label}
            active={screen === f.screen} badge={isInbox ? unread : undefined} onClick={() => onNavigate(f.screen)}>
            {f.icon}
          </RailButton>
        );
      })}
      <div aria-hidden className="my-1.5 h-px w-[26px] bg-[var(--v2-edge)]" />
      {tiles.map(p => {
        const open = inProject && p === project;
        return (
          <RailButton key={p} label={open ? `${p}, open` : p} title={p} active={open} onClick={() => onNavigate("workspace", p)}>
            <ProjectTile name={p} size={26} dot={p === project && needsYou ? "needs-you" : undefined} />
          </RailButton>
        );
      })}
      <RailButton label="All projects" title="All projects" active={screen === "projects"} onClick={() => onNavigate("projects")}>
        <FolderOpen size={18} aria-hidden />
      </RailButton>
      <RailButton label="Settings" title="Settings" active={screen === "settings"} onClick={() => onNavigate("settings")} className="mt-auto mb-2.5">
        <Settings size={18} aria-hidden />
      </RailButton>
    </nav>
  );
}
