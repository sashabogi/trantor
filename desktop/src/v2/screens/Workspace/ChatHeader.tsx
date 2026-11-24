// The chat column's icon row: Sessions, Files and Git open as a sheet over the chat, plus the menu and close (#13987 drill).
// Classic Chat keeps its own title, model and Hand off row underneath, so this row carries no second title.
import { useState } from "react";
import { Clock, FileText, GitBranch, MoreHorizontal, Plus, X } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import { MenuItem, Popover } from "../../shell/Popover";

export type SheetKind = "sessions" | "files" | "git";

export function ChatHeader({ brand, sheet, onSheet, changed, sessionId, onClose }: {
  brand: string | undefined; sheet: SheetKind | null; onSheet: (s: SheetKind | null) => void;
  changed: number; sessionId: string | null; onClose: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const toggle = (k: SheetKind) => onSheet(sheet === k ? null : k);
  const copy = () => { setMenu(false); if (sessionId) void navigator.clipboard?.writeText(sessionId).catch(() => {}); };
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] px-2.5 py-1.5">
      <Avatar name="orchestrator" llm={brand} size={22} />
      <span className="flex-1" />
      <IconButton label="New chat" title="A fresh session starts with Hand off in the chat header below" size={26} disabled>
        <Plus size={14} aria-hidden />
      </IconButton>
      <IconButton label="Sessions" title="Past Claude sessions" size={26} aria-pressed={sheet === "sessions"} onClick={() => toggle("sessions")}>
        <Clock size={14} aria-hidden />
      </IconButton>
      <IconButton label="Files" title="Project files" size={26} aria-pressed={sheet === "files"} onClick={() => toggle("files")}>
        <FileText size={14} aria-hidden />
      </IconButton>
      <IconButton label="Git" title="Git changes for the selected seat" size={26} badge={changed} badgeTone="info"
        aria-pressed={sheet === "git"} onClick={() => toggle("git")}>
        <GitBranch size={14} aria-hidden />
      </IconButton>
      <span className="relative inline-flex">
        <IconButton label="More" title="More chat actions" size={26} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>
          <MoreHorizontal size={14} aria-hidden />
        </IconButton>
        <Popover open={menu} onClose={() => setMenu(false)} label="Chat actions" align="right">
          <MenuItem onSelect={copy} title={sessionId ? "Copy the session id" : "No session id is known yet"}>
            <span className={sessionId ? "" : "opacity-45"}>Copy session id</span>
          </MenuItem>
          <MenuItem onSelect={() => { setMenu(false); onClose(); }}>Close chat</MenuItem>
        </Popover>
      </span>
      <IconButton label="Close chat" title="Close chat to the side rail" size={26} onClick={onClose}>
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}
