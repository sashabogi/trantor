// The project panel: Files, Git, Sessions and the orchestrator Chat, all classic components in 2.0 chrome (#13987).
import { saveTrayOpen } from "../../../features/chat/prefs";
import { useEffect, useState, type ReactNode } from "react";
import { Clock, FileText, GitBranch, MessageCircle } from "lucide-react";
import { Chat, DEFAULT_CHAT_DEPS, type ChatDeps } from "../../../features/chat/Chat";
import { FileTree } from "../../../features/code/FileTree";
import { GitPanel } from "../../../features/code/GitPanel";
import { SessionsMode } from "../../../features/code/SessionsMode";
import type { SessionRow } from "../../../features/code/sessionsApi";
import { initialTab, rightPanelApi, type PanelTab } from "../../../features/code/rightPanelState";
import type { Navigate } from "../../routes";
import { ComposerAdapter } from "./ComposerAdapter";
import type { SeatView } from "./seatModel";

/** Chat with the 2.0 composer swapped in; every other seam stays the production one. */
const CHAT_DEPS: ChatDeps = { ...DEFAULT_CHAT_DEPS, Composer: ComposerAdapter };

const TABS: { id: PanelTab; label: string; icon: ReactNode }[] = [
  { id: "files", label: "Files", icon: <FileText size={13} aria-hidden /> },
  { id: "git", label: "Git", icon: <GitBranch size={13} aria-hidden /> },
  { id: "sessions", label: "Sessions", icon: <Clock size={13} aria-hidden /> },
  { id: "chat", label: "Chat", icon: <MessageCircle size={13} aria-hidden /> },
];

function Empty({ children }: { children: ReactNode }) {
  return <div className="m-4 rounded-[10px] border border-dashed border-[var(--v2-edge-2)] p-4 text-center text-[12px] leading-relaxed text-[var(--v2-muted)]">{children}</div>;
}

export function RightPanel({ project, seat, hasOrchestrator, changed, onNavigate }: {
  project: string; seat: SeatView | undefined; hasOrchestrator: boolean; changed: number; onNavigate: Navigate;
}) {
  const [tab, setTab] = useState<PanelTab>(hasOrchestrator ? "chat" : "files");
  const [session, setSession] = useState<SessionRow | null>(null);
  useEffect(() => {
    let alive = true;
    rightPanelApi.get(project).then(s => { if (alive) setTab(initialTab(s?.tab ?? null, hasOrchestrator)); }).catch(() => {});
    return () => { alive = false; };
    // The stored tab is resolved once per project, so a live orchestrator can never pull the panel back (#6499).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  const pick = (t: PanelTab) => { if (t === "chat") setSession(null); setTab(t); void rightPanelApi.set(project, t); };
  const scope = seat && !seat.isOrchestrator && !seat.machine ? seat.agent : null;
  return (
    <aside aria-label="Project panel" className="flex min-h-0 w-[min(400px,100%)] shrink-0 flex-col border-l border-[var(--v2-edge)] bg-[#0F1013] max-[1100px]:w-[320px]">
      <div role="tablist" aria-label="Panel" className="flex gap-0.5 border-b border-[var(--v2-edge)] p-2">
        {TABS.map(t => {
          const on = t.id === tab;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => pick(t.id)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-[7px] border-0 p-1.5 text-[12px] font-medium ${
                on ? "bg-[var(--v2-edge)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
              {t.icon}{t.label}
              {t.id === "git" && changed > 0 && <span className="rounded-lg bg-[var(--v2-edge)] px-[5px] text-[10px]">{changed}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "files" && <FileTree project={project} seat={scope} onOpen={() => onNavigate("code")} />}
        {tab === "git" && (scope
          ? <GitPanel project={project} seat={scope} onOpenFile={() => onNavigate("code")} />
          : <Empty>Git works on a seat's worktree. Select a seat on this machine.</Empty>)}
        {tab === "sessions" && <SessionsMode project={project} onOpenClaude={s => { setSession(s); setTab("chat"); void rightPanelApi.set(project, "chat"); }} />}
        {tab === "chat" && (
          <ChatNoTray><Chat project={project} sessionId={session?.id} dock="pane" onDock={() => {}} deps={CHAT_DEPS}
            onClose={() => pick(session ? "sessions" : "files")} /></ChatNoTray>
        )}
      </div>
    </aside>
  );
}

// #13987 drill: Chat's read-only terminal tray is a second view of the pane already on the left, and opening it blanked that one.
export function ChatNoTray({ children }: { children: ReactNode }) {
  useState(() => { saveTrayOpen(false); return null; });
  return <div data-v2-chat className="flex min-h-0 flex-1 flex-col">{children}</div>;
}
