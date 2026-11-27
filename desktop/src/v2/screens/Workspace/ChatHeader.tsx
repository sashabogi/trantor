// One header for the session identity, live controls and workspace actions.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, GitBranch, MoreHorizontal, Plus, X } from "lucide-react";
import { brandFor } from "../../../shared/Avatar";
import { StatusLine, type HandoffControl } from "../../chat/StatusLine";
import { brandOfModel } from "../../ui/identity";
import { useOwnMachineId } from "../../ui/useMachineId";
import { Chip } from "../../ui/Chip";
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
            <span className="text-v2-small text-[var(--v2-muted)]">Writes a recap, opens a fresh session that takes over</span>
          </span>
        </MenuItem>
        {error && <div role="alert" className="px-2 py-1.5 text-v2-body text-[var(--v2-bad)]">{error}</div>}
      </Popover>
    </span>
  );
}

export type ChatHeaderState = {
  /** The session's model: the avatar's brand reads it. The model NAME shows in the composer, not here (#14515). */
  model: string;
  handoff: HandoffControl | null;
  onBack: (() => void) | null;
  title: string;
  branch: string;
  text: string | null;
  tone: "doing" | "warn" | "ok";
};

type HeaderActions = {
  sheet: SheetKind | null; onSheet: (s: SheetKind | null) => void;
  changed: number; sessionId: string | null; project: string; onGit: () => void; onClose: () => void;
};

export function ChatHeader({ state, brand, actions }: {
  state: ChatHeaderState; brand?: string; actions?: HeaderActions;
}) {
  const machineId = useOwnMachineId();
  const identity = !brand || brand === "orchestrator" ? brandOfModel(state.model) : brand;
  const provider = brandFor(identity ?? "orchestrator", undefined, machineId);
  const avatarTitle = provider ? `Orchestrator · ${provider.label === "Claude" ? "Claude Code" : provider.label}` : "Orchestrator";
  const title = state.title.trim() || "New chat";
  return (
    <header aria-label="Chat" className="flex min-w-0 shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] px-2.5 py-1.5">
      {provider ? (
        <span role="img" aria-label={avatarTitle} title={avatarTitle} className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--v2-raised)] text-[var(--v2-text-2)]">
          <span aria-hidden data-brand={provider.label} className="inline-flex size-4" dangerouslySetInnerHTML={{ __html: provider.svg }} />
        </span>
      ) : <Avatar name="orchestrator" size={22} />}
      <div className="min-w-0 flex-1 basis-24 px-1">
        <div title={title} className="truncate text-v2-base font-medium text-[var(--v2-text)]">{title}</div>
        {state.text && <div data-testid="chat-status" data-tone={state.tone} title={state.text} className="truncate text-v2-small text-[var(--v2-muted)]">{state.text}</div>}
      </div>
      {state.branch && <span className="flex min-w-0 max-w-28 [&>span]:min-w-0 [&>span]:max-w-full"><Chip mono title={`This chat's session works on branch ${state.branch}`} icon={<GitBranch size={12} className="shrink-0" aria-hidden />}><span className="truncate">on {state.branch}</span></Chip></span>}
      <StatusLine handoff={state.handoff} onBack={state.onBack} />
      {actions && <HeaderButtons {...actions} />}
    </header>
  );
}

function HeaderButtons({ sheet, onSheet, changed, sessionId, project, onGit, onClose }: HeaderActions) {
  const [menu, setMenu] = useState(false);
  const copy = () => { setMenu(false); if (sessionId) void navigator.clipboard?.writeText(sessionId).catch(() => {}); };
  return (
    <div className="flex shrink-0 items-center">
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
