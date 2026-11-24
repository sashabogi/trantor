// The chat column's content: the orchestrator Chat is the only permanent view; Sessions, Files and Git open as a sheet over it (#13987 drill).
import { saveTrayOpen } from "../../../features/chat/prefs";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Chat, DEFAULT_CHAT_DEPS, type ChatDeps } from "../../../features/chat/Chat";
import { FileTree } from "../../../features/code/FileTree";
import { GitPanel } from "../../../features/code/GitPanel";
import { SessionsMode } from "../../../features/code/SessionsMode";
import type { SessionRow } from "../../../features/code/sessionsApi";
import type { Navigate } from "../../routes";
import { IconButton } from "../../ui/IconButton";
import { ChatHeader, type SheetKind } from "./ChatHeader";
import { ComposerAdapter } from "./ComposerAdapter";
import type { SeatView } from "./seatModel";

/** Chat with the 2.0 composer swapped in; every other seam stays the production one. */
const CHAT_DEPS: ChatDeps = { ...DEFAULT_CHAT_DEPS, Composer: ComposerAdapter };

const SHEET_TITLE = { sessions: "Sessions", files: "Files", git: "Git" } as const satisfies Record<SheetKind, string>;

function Empty({ children }: { children: ReactNode }) {
  return <div className="m-4 rounded-[10px] border border-dashed border-[var(--v2-edge-2)] p-4 text-center text-[12px] leading-relaxed text-[var(--v2-muted)]">{children}</div>;
}

function Sheet({ kind, onBack, children }: { kind: SheetKind; onBack: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <div role="dialog" aria-label={SHEET_TITLE[kind]} className="absolute inset-0 z-20 flex flex-col bg-[#0F1013]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--v2-edge)] px-2.5 py-1.5">
        <IconButton label="Back to chat" title="Back to chat" size={26} onClick={onBack}><ArrowLeft size={14} aria-hidden /></IconButton>
        <span className="text-[12.5px] font-semibold">{SHEET_TITLE[kind]}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

export function RightPanel({ project, seat, orchestrator, changed, onNavigate, onClose }: {
  project: string; seat: SeatView | undefined; orchestrator: SeatView | undefined; changed: number;
  onNavigate: Navigate; onClose: () => void;
}) {
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [session, setSession] = useState<SessionRow | null>(null);
  const scope = seat && !seat.isOrchestrator && !seat.machine ? seat.agent : null;
  const back = () => setSheet(null);
  return (
    <section aria-label="Project panel" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatHeader brand={orchestrator?.brand} sheet={sheet} onSheet={setSheet} changed={changed}
        sessionId={session?.id ?? orchestrator?.session ?? null} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatNoTray><Chat key={session?.id ?? "live"} project={project} sessionId={session?.id} dock="pane" onDock={() => {}} deps={CHAT_DEPS}
          onClose={() => setSession(null)} /></ChatNoTray>
      </div>
      {sheet === "sessions" && (
        <Sheet kind="sessions" onBack={back}>
          <SessionsMode project={project} onOpenClaude={s => { setSession(s); back(); }} />
        </Sheet>
      )}
      {sheet === "files" && (
        <Sheet kind="files" onBack={back}><FileTree project={project} seat={scope} onOpen={() => onNavigate("code")} /></Sheet>
      )}
      {sheet === "git" && (
        <Sheet kind="git" onBack={back}>
          {scope
            ? <GitPanel project={project} seat={scope} onOpenFile={() => onNavigate("code")} />
            : <Empty>Git works on a seat's worktree. Select a seat on this machine.</Empty>}
        </Sheet>
      )}
    </section>
  );
}

// #13987 drill: Chat's read-only terminal tray is a second view of the pane already on the left, and opening it blanked that one.
export function ChatNoTray({ children }: { children: ReactNode }) {
  useState(() => { saveTrayOpen(false); return null; });
  return <div data-v2-chat className="flex min-h-0 flex-1 flex-col">{children}</div>;
}
