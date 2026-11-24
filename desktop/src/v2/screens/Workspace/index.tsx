// The project Workspace screen: seat strip, inspector, work area and the project panel (#13987).
// The shell already renders the project header and lens tabs; this is everything under them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DrillMode } from "../../../features/drill/DrillMode";
import type { ScreenProps } from "../../routes";
import { Inspector } from "./Inspector";
import { usePanes } from "./panes";
import { SeatGrid } from "./SeatGrid";
import { SeatStrip } from "./SeatStrip";
import { liveSeats, visibleSeats, type Layout, type SeatView } from "./seatModel";
import { useCrew } from "./useCrew";
import { useSeatDiff } from "./useSeatDiff";
import { cardOf, useMayDo, useWorkspaceData } from "./useWorkspaceData";
import { WorkArea, type WorkTab } from "./WorkArea";

const LAYOUT_KEY = "trantor.v2.workspace.layout";

function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === "split" || v === "grid" ? v : "focus";
  } catch { return "focus"; }
}

/** The signed identity DrillMode records evidence under; empty until the desktop answers. */
function useIdentity(): string {
  const [me, setMe] = useState("");
  useEffect(() => {
    let alive = true;
    void invoke<string>("identity_name", {}).then(n => { if (alive) setMe(n); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return me;
}

/** The chosen seat, else the first live crew seat, else whatever leads the strip. */
function pickSeat(seats: SeatView[], key: string | null): SeatView | undefined {
  return seats.find(s => s.key === key)
    ?? liveSeats(seats).find(s => !s.isOrchestrator) ?? liveSeats(seats)[0] ?? seats[0];
}

function EmptyCrew() {
  return (
    <div className="m-5 rounded-xl border border-dashed border-[var(--v2-edge-2)] p-6 text-center text-[12.5px] leading-relaxed text-[var(--v2-muted)]">
      No crew on this project yet. Add a seat above and its live terminal renders here.
    </div>
  );
}

export function WorkspaceScreen({ client, project, onNavigate }: ScreenProps) {
  const { RightPanel } = usePanes();
  const data = useWorkspaceData(client, project);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [tab, setTab] = useState<WorkTab>("terminal");
  const [recording, setRecording] = useState(false);
  const messageRef = useRef<HTMLInputElement | null>(null);
  const me = useIdentity();
  const mayDo = useMayDo(project);
  const crew = useCrew(project, data.refresh);

  const seats = useMemo(() => data.seats ?? [], [data.seats]);
  const selected = pickSeat(seats, selKey);
  const diff = useSeatDiff(project, selected, tab === "changes");
  const pickLayout = useCallback((l: Layout) => {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* storage blocked: the layout lasts the session */ }
  }, []);
  const focusSeat = (key: string) => { setSelKey(key); pickLayout("focus"); };
  const message = () => {
    pickLayout("focus");
    setTab("terminal");
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  let body;
  if (data.seats === null) body = <div className="m-5 text-[12.5px] text-[var(--v2-muted)]">Reading seats</div>;
  else if (!selected) body = <EmptyCrew />;
  else if (layout === "focus") {
    body = <WorkArea client={client} project={project} seat={selected} holds={data.holds.filter(h => h.session === selected.session)}
      diff={diff} tab={tab} onTab={setTab} messageRef={messageRef} onDecided={data.refresh} />;
  } else {
    body = <SeatGrid project={project} seats={visibleSeats(layout, liveSeats(seats), selected)} layout={layout}
      selectedKey={selected.key} onFocus={focusSeat} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SeatStrip seats={seats} selectedKey={selected?.key} onSelect={setSelKey} layout={layout} onLayout={pickLayout}
          crew={crew} recording={recording} onRecord={() => setRecording(r => !r)} />
        {selected && <Inspector key={selected.key} project={project} seat={selected} card={cardOf(data.cards, selected)}
          mayDo={mayDo} crew={crew} onNavigate={onNavigate} onMessage={message} />}
        {body}
      </div>
      <RightPanel project={project} seat={selected} hasOrchestrator={seats.some(s => s.isOrchestrator)}
        changed={diff.diff?.files.length ?? 0} onNavigate={onNavigate} />
      {recording && (me
        ? <DrillMode me={me} onClose={() => setRecording(false)} />
        : <div role="alert" className="fixed bottom-14 right-4 z-40 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-3 py-2 text-[12px] text-[var(--v2-muted)]">Waiting for the signed identity before a drill can start.</div>)}
    </div>
  );
}
