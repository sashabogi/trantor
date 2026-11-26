import { useActivePane } from "../../ui/useActivePane";
// The left icon bar (#13988). A sidebar that folds away still leaves its icon here.
import { Bot, FolderTree, GitBranch, LayoutList, Search } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../../ui/IconButton";

export type SideView = "explorer" | "search" | "source" | "agents" | "cards";

const ITEMS: { view: SideView; label: string; title: string; icon: ReactNode }[] = [
  { view: "explorer", label: "Explorer", title: "Explorer", icon: <FolderTree size={17} aria-hidden /> },
  { view: "search", label: "Search", title: "Search", icon: <Search size={17} aria-hidden /> },
  { view: "source", label: "Source control", title: "Source control", icon: <GitBranch size={17} aria-hidden /> },
  { view: "agents", label: "Agents", title: "Agents", icon: <Bot size={17} aria-hidden /> },
  { view: "cards", label: "Cards", title: "Cards", icon: <LayoutList size={17} aria-hidden /> },
];

export function IconBar({ active, folded, onPick, changeCount }: { active: SideView; folded: boolean; onPick: (v: SideView) => void; changeCount: number }) {
  const pane = useActivePane();
  return (
    <nav {...pane} aria-label="Sidebar views" className="flex w-[50px] shrink-0 flex-col items-center gap-1 overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-chrome)] py-2">
      {ITEMS.map(i => {
        const badge = i.view === "source" ? changeCount : null;
        const label = badge ? `${i.label}, ${badge} ${badge === 1 ? "change" : "changes"}` : i.label;
        const on = i.view === active && !folded;
        return (
          <IconButton key={i.view} label={label} title={i.title} size={38} badge={badge} badgeTone="info" aria-current={on || undefined}
            className={on ? "!bg-[var(--v2-accent-soft)] !text-[var(--v2-text)]" : ""} onClick={() => onPick(i.view)}>
            {i.icon}
          </IconButton>
        );
      })}
    </nav>
  );
}
