// The work area for one seat: the seat bar, Terminal or Changes full bleed, the approval, the message bar (#13987, #14053, #14351).
import { lazy, Suspense, type RefObject } from "react";
import type { Card, FileHold, HubClient } from "../../../shared/api/client";
import { PaneBoundary } from "../../../features/workspace/PaneBoundary";
import { NotWired } from "../../shell/ClassicLenses";
import type { Navigate } from "../../routes";
import { Approval } from "./Approval";
import type { BrowserPreview } from "./browserModel";
import { BrowserTab } from "./BrowserTab";
import { SeatBar, type WorkTab } from "./SeatBar";
import { usePanes } from "./panes";
import { takesSeatMessage } from "./seatModel";
import { SeatMessage } from "./SeatMessage";
import type { Crew } from "./useCrew";
import { SubagentPane } from "./SubagentPane";
import type { SeatView } from "./seatModel";
import type { DiffState } from "./useSeatDiff";

const ChangesTab = lazy(() => import("./ChangesTab"));

export type { WorkTab };

/** The live terminal for one seat; shared by Focus, Split and Grid so they never drift (#13987). */
export function SeatTerminal({ project, seat, interactive }: { project: string; seat: SeatView; interactive: boolean }) {
  const { TerminalPane: Terminal } = usePanes();
  return (
    <PaneBoundary key={seat.key}>
      <Terminal project={project} agent={seat.agent} peer={seat.target} interactive={interactive} />
    </PaneBoundary>
  );
}

/** What a tile shows for a seat: a sub-agent's conversation, else its terminal (#14265). */
export function SeatPane({ project, seat, interactive }: { project: string; seat: SeatView; interactive: boolean }) {
  return seat.agentInfo ? <SubagentPane key={seat.key} project={project} seat={seat} /> : <SeatTerminal project={project} seat={seat} interactive={interactive} />;
}

function TabBody({ tab, project, seat, diff }: { tab: WorkTab; project: string; seat: SeatView; diff: DiffState }) {
  if (tab === "terminal") {
    return <div className="flex min-h-[360px] min-w-0 flex-1 flex-col bg-[var(--v2-terminal)]"><SeatTerminal project={project} seat={seat} interactive /></div>;
  }
  if (seat.isHelper) return <NotWired title="Changes" line="Helpers keep their output in the terminal." />;
  if (seat.isOrchestrator) return <NotWired title="Changes" line="The orchestrator works in the project checkout; open Code to review it." />;
  if (seat.machine) return <NotWired title="Changes" line={`${seat.label} runs on ${seat.machine}; its diff is not readable from here yet.`} />;
  return <Suspense fallback={<div className="p-4 text-v2-base text-[var(--v2-muted)]">Loading the diff view</div>}><ChangesTab state={diff} seatName={seat.label} /></Suspense>;
}

export function WorkArea({ client, project, seat, card, crew, holds, diff, tab, onTab, messageRef, onDecided, onNavigate, onMessage, browserMax, onBrowserMax, previews = [] }: {
  previews?: BrowserPreview[];
  client: HubClient; project: string; seat: SeatView; card: Card | undefined; crew: Crew; holds: FileHold[]; diff: DiffState;
  tab: WorkTab; onTab: (t: WorkTab) => void; messageRef: RefObject<HTMLInputElement | null>; onDecided: () => void;
  onNavigate: Navigate; onMessage: () => void; browserMax: boolean; onBrowserMax: (m: boolean) => void;
}) {
  const changed = diff.diff?.files.length ?? 0;
  // #14265: a sub-agent is read-only, so its pane has no Terminal and Changes tabs, no approval and no message box.
  if (seat.agentInfo && tab !== "browser") return <div className="flex min-h-0 flex-1 flex-col"><SubagentPane key={seat.key} project={project} seat={seat} /></div>;
  // #14505: maximized, the browser is the whole column — no seat bar, no approval, no message line.
  const browserOnly = browserMax && tab === "browser";
  return (
    // #14250: the centre column is the panel, so the work area carries no frame of its own.
    <div className="flex min-h-0 flex-1 flex-col">
      {!browserOnly && <SeatBar project={project} seat={seat} card={card} crew={crew} tab={tab} onTab={onTab} changed={changed} onNavigate={onNavigate} onMessage={onMessage} />}
      {tab === "browser"
        ? <BrowserTab previews={previews} project={project} maximized={browserMax} onMaximize={onBrowserMax} />
        : <TabBody tab={tab} project={project} seat={seat} diff={diff} />}
      {!browserOnly && <Approval client={client} holds={holds} seatName={seat.label} onDecided={onDecided} />}
      {/* #14254: the orchestrator is spoken to in the chat panel, so its pane carries no message box. */}
      {!browserOnly && takesSeatMessage(seat) && <SeatMessage key={seat.key} client={client} project={project} seat={seat} inputRef={messageRef} />}
    </div>
  );
}
