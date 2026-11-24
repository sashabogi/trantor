// The chat column's icon row: New chat menu, Sessions sheet, Git (opens Code), the menu and close (#13987 drill).
// Classic Chat keeps its own title, model and Hand off row underneath, so this row carries no second title.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, GitBranch, MoreHorizontal, Plus, X } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import { MenuItem, Popover } from "../../shell/Popover";

export type SheetKind = "sessions";

// #13987 drill: the same Tauri command the classic Chat's Hand off button invokes (reason "clicked"); the Rust side writes the recap and the fresh session takes over.
function NewChatMenu({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setOpen(false); setConfirm(false); };
  const handOff = () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    setError(null);
    invoke<string>("handoff_now", { project, reason: "clicked" })
      .then(() => close())
      .catch(e => { setError(String(e)); setConfirm(false); })
      .finally(() => setBusy(false));
  };
  return (
    <span className="relative inline-flex">
      <IconButton label="New chat" title="Start a fresh chat" size={26} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(o => !o); setConfirm(false); }}>
        <Plus size={14} aria-hidden />
      </IconButton>
      <Popover open={open} onClose={close} label="New chat" align="right">
        <MenuItem onSelect={handOff} title="Writes a recap, opens a fresh session that takes over">
          <span className="flex flex-col">
            <span>{busy ? "Handing off" : confirm ? "Confirm: hand off now" : "Hand off to a fresh session"}</span>
            <span className="text-[11px] text-[var(--v2-muted)]">Writes a recap, opens a fresh session that takes over</span>
          </span>
        </MenuItem>
        {error && <div role="alert" className="px-2 py-1.5 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
      </Popover>
    </span>
  );
}

export function ChatHeader({ brand, sheet, onSheet, changed, sessionId, project, onGit, onClose }: {
  brand: string | undefined; sheet: SheetKind | null; onSheet: (s: SheetKind | null) => void;
  changed: number; sessionId: string | null; project: string; onGit: () => void; onClose: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const copy = () => { setMenu(false); if (sessionId) void navigator.clipboard?.writeText(sessionId).catch(() => {}); };
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] px-2.5 py-1.5">
      <Avatar name="orchestrator" llm={brand} size={22} />
      <span className="flex-1" />
      <NewChatMenu project={project} />
      <IconButton label="Sessions" title="Past Claude sessions" size={26} aria-pressed={sheet === "sessions"} onClick={() => onSheet(sheet === "sessions" ? null : "sessions")}>
        <Clock size={14} aria-hidden />
      </IconButton>
      <IconButton label="Git" title="Open source control" size={26} badge={changed} badgeTone="info" onClick={onGit}>
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
