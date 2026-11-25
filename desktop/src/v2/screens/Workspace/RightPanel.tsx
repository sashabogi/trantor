// The chat column's content: the orchestrator Chat is the only permanent view; Sessions opens as a sheet over it (#13987 drill).
import { saveTrayOpen } from "../../../features/chat/prefs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Chat, DEFAULT_CHAT_DEPS, type ChatDeps } from "../../../features/chat/Chat";
import { SessionsMode } from "../../../features/code/SessionsMode";
import type { SessionRow } from "../../../features/code/sessionsApi";
import type { Navigate } from "../../routes";
import { setOpenIntent } from "../../shell/openIntent";
import { IconButton } from "../../ui/IconButton";
import { ChatHeader, type SheetKind } from "./ChatHeader";
import { ComposerAdapter } from "./ComposerAdapter";
import { PromptTimeline } from "./PromptTimeline";
import type { SeatView } from "./seatModel";

/** Chat with the 2.0 composer swapped in; every other seam stays the production one. */
const CHAT_DEPS: ChatDeps = { ...DEFAULT_CHAT_DEPS, Composer: ComposerAdapter };

const SHEET_TITLE = { sessions: "Sessions" } as const satisfies Record<SheetKind, string>;

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
  // #13987 drill: Git is the Code screen's Source control, not a sheet; the seat travels with the intent.
  const openGit = () => { setOpenIntent(project, { kind: "source-control", seat: scope ?? undefined }); onNavigate("code"); };
  // #14084 drill: a changed file named on a prompt tick's card opens Code on that change.
  const openChange = (path: string) => { setOpenIntent(project, { kind: "change", path, seat: scope ?? undefined }); onNavigate("code"); };
  return (
    <section aria-label="Project panel" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatHeader brand={orchestrator?.brand} sheet={sheet} onSheet={setSheet} changed={changed} project={project}
        sessionId={session?.id ?? orchestrator?.session ?? null} onGit={openGit} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatNoTray onOpenChange={openChange}><Chat key={session?.id ?? "live"} project={project} sessionId={session?.id} dock="pane" onDock={() => {}} deps={CHAT_DEPS}
          onClose={() => setSession(null)} /></ChatNoTray>
      </div>
      {sheet === "sessions" && (
        <Sheet kind="sessions" onBack={back}>
          <SessionsMode project={project} onOpenClaude={s => { setSession(s); back(); }} />
        </Sheet>
      )}
    </section>
  );
}

// #13987 drill: Chat's read-only terminal tray is a second view of the pane already on the left, and opening it blanked that one.
export function ChatNoTray({ children, onOpenChange }: { children: ReactNode; onOpenChange: (path: string) => void }) {
  useState(() => { saveTrayOpen(false); return null; });
  const chat = useRef<HTMLDivElement | null>(null);
  // The timeline sits beside the chat, so it never covers the scrollbar or the composer (#14075).
  return (
    <div className="flex min-h-0 flex-1">
      <div ref={chat} data-v2-chat className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      <PromptTimeline root={chat} onOpenChange={onOpenChange} />
    </div>
  );
}
