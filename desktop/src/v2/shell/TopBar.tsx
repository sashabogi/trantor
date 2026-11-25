// Top bar from the Workspace/Dashboard artboards: project switcher, mode, search, bell, account (#v2-F).
import { useState, type ReactNode } from "react";
import { Bell, ChevronDown, Code2, Network, Plus, Search, SplitSquareHorizontal } from "lucide-react";
import { Seg, type SegOption } from "../ui/Seg";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { ProjectTile } from "../ui/ProjectTile";
import { Avatar } from "../ui/Avatar";
import { Popover, MenuItem } from "./Popover";
import type { Navigate } from "../routes";
import { MODE_CONFIG, type Mode } from "./shellMode";

const MODES: readonly SegOption<Mode>[] = [
  { value: "orchestrator", label: "Orchestrator", icon: <Network size={13} aria-hidden />, title: "Run the crew: board, seats, decisions" },
  { value: "mixed", label: "Mixed", icon: <SplitSquareHorizontal size={13} aria-hidden />, title: MODE_CONFIG.mixed.unavailable, disabled: true },
  { value: "developer", label: "Developer", icon: <Code2 size={13} aria-hidden />, title: "Code first: files, diffs, terminal" },
];

export type TopBarProps = {
  projects: string[];
  project: string;
  onProject: (p: string) => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  onSearch: () => void;
  needsYou: number;
  me: string;
  onNavigate: Navigate;
  onStartProject: () => void;
  onBackToClassic: () => void;
  notice?: ReactNode;
};

function ProjectSwitcher({ projects, project, onProject, onStartProject }: Pick<TopBarProps, "projects" | "project" | "onProject" | "onStartProject">) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title="Switch project"
        className="v2-hover inline-flex items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-v2-base font-semibold text-[var(--v2-text)]">
        {project ? <ProjectTile name={project} size={22} /> : null}
        {project || "No project"}
        <ChevronDown size={12} aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Projects">
        <MenuItem onSelect={() => { setOpen(false); onStartProject(); }} title="Create a project and wake its orchestrator (⌘N)">
          <Plus size={14} aria-hidden /><span className="flex-1">Start a project</span><Kbd>⌘N</Kbd>
        </MenuItem>
        {projects.map(p => (
          <MenuItem key={p} active={p === project} onSelect={() => { onProject(p); setOpen(false); }}>
            <ProjectTile name={p} size={20} />{p}
          </MenuItem>
        ))}
        {!projects.length && <div className="px-2 py-1.5 text-v2-body text-[var(--v2-muted)]">No projects pinned. Run trantor hub set</div>}
      </Popover>
    </div>
  );
}

function AccountMenu({ me, onNavigate, onBackToClassic }: Pick<TopBarProps, "me" | "onNavigate" | "onBackToClassic">) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${me || "not signed"}`}
        title="Account" onClick={() => setOpen(o => !o)} className="rounded-full border-0 bg-transparent p-0">
        <Avatar name={me || "?"} size={30} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Account" align="right">
        <div className="px-2 py-1.5 text-v2-body text-[var(--v2-muted)]">Signed as <span className="text-[var(--v2-text)]">{me || "unknown"}</span></div>
        <MenuItem onSelect={() => { setOpen(false); onNavigate("settings"); }}>Settings</MenuItem>
        <MenuItem onSelect={onBackToClassic} title="Switch back to the classic app">Back to classic</MenuItem>
      </Popover>
    </div>
  );
}

export function TopBar(p: TopBarProps) {
  return (
    <header className="flex h-[50px] shrink-0 items-center gap-3 border-b border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-[14px]">
      <ProjectSwitcher projects={p.projects} project={p.project} onProject={p.onProject} onStartProject={p.onStartProject} />
      <Seg label="Mode" options={MODES} value={p.mode} onChange={p.onMode} />
      <button type="button" onClick={p.onSearch} title="Search cards, messages and files (⌘K)"
        className="flex max-w-[480px] flex-[1_1_280px] items-center gap-2 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-left text-v2-body text-[var(--v2-muted)]">
        <Search size={14} aria-hidden />
        <span className="flex-1 truncate">Search {p.project || "everything"}: text, #id, @assignee</span>
        <Kbd>⌘K</Kbd>
      </button>
      {p.notice}
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton label={p.needsYou ? `Notifications, ${p.needsYou} need you` : "Notifications"} title="Notifications: decisions waiting on you"
          variant="outline" size={32} badge={p.needsYou} onClick={() => p.onNavigate("inbox")}>
          <Bell size={15} aria-hidden />
        </IconButton>
        <AccountMenu me={p.me} onNavigate={p.onNavigate} onBackToClassic={p.onBackToClassic} />
      </div>
    </header>
  );
}
