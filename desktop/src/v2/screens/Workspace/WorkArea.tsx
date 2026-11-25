// The work area for one seat: Terminal and Changes, the approval, the message line (#13987, #14053).
// #14241: the work tabs ride the shared Tabs bar, joined to the pane below them.
import { lazy, Suspense, type ReactNode, type RefObject } from "react";
import { FileDiff, SquareTerminal } from "lucide-react";
import type { FileHold, HubClient } from "../../../shared/api/client";
import { PaneBoundary } from "../../../features/workspace/PaneBoundary";
import { NotWired } from "../../shell/ClassicLenses";
import { Tabs } from "../../ui/Tabs";
import { Approval } from "./Approval";
import { usePanes } from "./panes";
import { takesSeatMessage } from "./seatModel";
import { SeatMessage } from "./SeatMessage";
import type { SeatView } from "./seatModel";
import type { DiffState } from "./useSeatDiff";

const ChangesTab = lazy(() => import("./ChangesTab"));

export type WorkTab = "terminal" | "changes";

const TABS: { id: WorkTab; label: string; icon: ReactNode }[] = [
  { id: "terminal", label: "Terminal", icon: <SquareTerminal size={12} aria-hidden /> },
  { id: "changes", label: "Changes", icon: <FileDiff size={12} aria-hidden /> },
];

/** The live terminal for one seat; shared by Focus, Split and Grid so they never drift (#13987). */
export function SeatTerminal({ project, seat, interactive }: { project: string; seat: SeatView; interactive: boolean }) {
  const { TerminalPane: Terminal } = usePanes();
  return (
    <PaneBoundary key={seat.key}>
      <Terminal project={project} agent={seat.agent} peer={seat.target} interactive={interactive} />
    </PaneBoundary>
  );
}

function TabBody({ tab, project, seat, diff }: { tab: WorkTab; project: string; seat: SeatView; diff: DiffState }) {
  if (tab === "terminal") {
    return <div className="flex min-h-[360px] min-w-0 flex-1 flex-col p-2"><SeatTerminal project={project} seat={seat} interactive /></div>;
  }
  if (seat.isHelper) return <NotWired title="Changes" line="Helpers keep their output in the terminal." />;
  if (seat.isOrchestrator) return <NotWired title="Changes" line="The orchestrator works in the project checkout; open Code to review it." />;
  if (seat.machine) return <NotWired title="Changes" line={`${seat.label} runs on ${seat.machine}; its diff is not readable from here yet.`} />;
  return <Suspense fallback={<div className="p-4 text-v2-base text-[var(--v2-muted)]">Loading the diff view</div>}><ChangesTab state={diff} seatName={seat.label} /></Suspense>;
}

export function WorkArea({ client, project, seat, holds, diff, tab, onTab, messageRef, onDecided }: {
  client: HubClient; project: string; seat: SeatView; holds: FileHold[]; diff: DiffState;
  tab: WorkTab; onTab: (t: WorkTab) => void; messageRef: RefObject<HTMLInputElement | null>; onDecided: () => void;
}) {
  const changed = diff.diff?.files.length ?? 0;
  return (
    // #14250: the centre column is the panel, so the work area carries no frame of its own.
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs label="Seat views" pane="var(--v2-bg)" barClassName="h-9 bg-[var(--v2-sunken)] px-2"
        tabs={TABS.map(t => ({
          id: t.id,
          label: t.label,
          leading: t.icon,
          sub: t.id === "changes" && changed > 0 ? <span className="rounded-lg bg-[var(--v2-edge)] px-[5px] text-v2-micro">{changed}</span> : undefined,
        }))}
        activeId={tab} onSelect={onTab}
        end={<span className="inline-flex items-center gap-[5px] text-v2-small text-[var(--v2-muted)]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: seat.presence === "offline" ? "var(--v2-track)" : "var(--v2-ok)" }} />
          {seat.isHelper ? seat.words : seat.presence === "offline" ? "offline" : "live"}{seat.machine ? ` · ${seat.machine}` : ""}
        </span>} />
      <TabBody tab={tab} project={project} seat={seat} diff={diff} />
      <Approval client={client} holds={holds} seatName={seat.label} onDecided={onDecided} />
      {/* #14254: the orchestrator is spoken to in the chat panel, so its pane carries no message box. */}
      {takesSeatMessage(seat) && <SeatMessage key={seat.key} client={client} project={project} seat={seat} inputRef={messageRef} />}
    </div>
  );
}
