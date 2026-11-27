import { useActivePane } from "../../ui/useActivePane";
// The project Workspace screen: seat strip, inspector, work area and the project panel (#13987).
// The shell already renders the project header and lens tabs; this is everything under them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BROWSER_REVEAL_EVENT } from "./browserModel";
import { DrillMode } from "../../../features/drill/DrillMode";
import type { ScreenProps } from "../../routes";
import { ChatLinks } from "../../chat/LinkContext";
import { ChatColumn } from "./ChatColumn";
import { useChatColumn, useFilesColumn } from "./chatColumnState";
import { FilesColumn } from "./FilesColumn";
import { setOpenIntent } from "../../shell/openIntent";
import { usePanes } from "./panes";
import { useSeats } from "../Code/useSeats";
import { SeatGrid } from "./SeatGrid";
import { SeatStrip } from "./SeatStrip";
import { liveSeats, tileSeats, visibleSeats, type Layout, type SeatView } from "./seatModel";
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
// #13987 drill: opening a project lands on its orchestrator, not the first crew seat.
export function pickSeat(seats: SeatView[], key: string | null): SeatView | undefined {
  return seats.find(s => s.key === key)
    ?? liveSeats(seats).find(s => s.isOrchestrator) ?? liveSeats(seats)[0] ?? seats[0];
}

const seatKey = (project: string) => `trantor.v2.workspace.seat.${project}`;
function readSeat(project: string): string | null {
  try { return localStorage.getItem(seatKey(project)); } catch { return null; }
}

function EmptyCrew() {
  return (
    <div className="m-5 rounded-xl border border-dashed border-[var(--v2-edge-2)] p-6 text-center text-v2-base leading-relaxed text-[var(--v2-muted)]">
      No crew on this project yet. Add a seat above and its live terminal renders here.
    </div>
  );
}

export function WorkspaceScreen({ client, project, onNavigate, wake }: ScreenProps) {
  const { RightPanel } = usePanes();
  const data = useWorkspaceData(client, project);
  const [selKey, setSelKeyState] = useState<string | null>(() => readSeat(project));
  const setSelKey = useCallback((key: string) => {
    setSelKeyState(key);
    try { localStorage.setItem(seatKey(project), key); } catch { /* storage blocked: the choice lasts the session */ }
  }, [project]);
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [tab, setTab] = useState<WorkTab>("terminal");
  // #14505: a maximized browser fills the Workspace; Esc or Restore puts the columns back.
  const [browserMax, setBrowserMax] = useState(false);
  const [recording, setRecording] = useState(false);
  const messageRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const chatCol = useChatColumn();
  const filesCol = useFilesColumn();
  const me = useIdentity();
  const mayDo = useMayDo(project);
  const crew = useCrew(project, data.refresh);

  const seats = useMemo(() => data.seats ?? [], [data.seats]);
  const selected = pickSeat(seats, selKey);
  const pane = useActivePane(layout === "focus" && selected?.presence === "working");
  const diff = useSeatDiff(project, selected, tab === "changes");
  const pickLayout = useCallback((l: Layout) => {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* storage blocked: the layout lasts the session */ }
  }, []);
  const focusSeat = (key: string) => { setSelKey(key); pickLayout("focus"); };
  // An agent that opens a page brings the Browser tab forward, so you can watch it drive.
  useEffect(() => {
    const off = listen<{ project: string }>(BROWSER_REVEAL_EVENT, e => {
      if (e.payload.project !== project) return;
      pickLayout("focus");
      setTab("browser");
    });
    return () => { void off.then(stop => stop()).catch(() => {}); };
  }, [project, pickLayout]);
  const message = () => {
    pickLayout("focus");
    setTab("terminal");
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  // The same scoping the Files sheet used: a crew seat on this machine shows its worktree, anything else the project checkout.
  const [shownScope, setShownScope] = useState<string | null>(null);
  const scope = selected && !selected.isOrchestrator && !selected.isHelper && !selected.agentInfo && !selected.machine ? selected.agent : null;
  // #14047 drill: the seat rows under Branches and seats, branch and ahead count included.
  const { seats: seatInfos } = useSeats(client, project);
  // A row click in the sidebar's Branches and seats section: that seat in the strip, the main checkout row the orchestrator.
  const pickScope = useCallback((seat: string | null) => {
    const view = seat === null ? seats.find(s => s.isOrchestrator) : seats.find(s => s.agent === seat);
    if (view) setSelKey(view.key);
  }, [seats, setSelKey]);
  // #13987 drill: a chosen file used to be dropped on navigate; the intent carries it to the Code screen.
  // #14265: the intents carry the scope the sidebar shows, which is a wt: scope while an agent worktree is picked.
  // #14344: the last file opened from the sidebar keeps its selected row, like the Code screen's open file.
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const openFile = (path: string) => { setOpenedPath(path); setOpenIntent(project, { kind: "file", path, seat: (shownScope ?? scope) ?? undefined }); onNavigate("code"); };
  // #14044 drill: a changed file or a commit clicked in the source control sidebar opens Code on it.
  const openChange = (path: string) => { setOpenedPath(path); setOpenIntent(project, { kind: "change", path, seat: (shownScope ?? scope) ?? undefined }); onNavigate("code"); };
  const openConflict = (path: string) => { setOpenedPath(path); setOpenIntent(project, { kind: "conflict", path, seat: (shownScope ?? scope) ?? undefined }); onNavigate("code"); };
  const openCommit = (sha: string) => { setOpenIntent(project, { kind: "commit", sha, seat: (shownScope ?? scope) ?? undefined }); onNavigate("code"); };

  // #14351: what each seat needs from you, for the "needs you: approve edit a.ts" line on its tab and tile.
  const needs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of seats) {
      const hold = data.holds.find(h => h.session === s.session);
      if (hold) out[s.key] = `approve edit ${hold.file.split("/").pop()}`;
    }
    return out;
  }, [seats, data.holds]);

  let body;
  if (data.error && data.seats === null) body = <div role="alert" className="m-5 text-v2-base text-[var(--v2-muted)]">Can't reach the hub. {data.error}</div>;
  else if (data.seats === null) body = <div className="m-5 text-v2-base text-[var(--v2-muted)]">Reading seats</div>;
  else if (!selected) body = <EmptyCrew />;
  else if (layout === "focus") {
    body = <WorkArea client={client} project={project} seat={selected} card={cardOf(data.cards, selected)} crew={crew} holds={data.holds.filter(h => h.session === selected.session)}
      diff={diff} tab={tab} onTab={setTab} messageRef={messageRef} onDecided={data.refresh} onNavigate={onNavigate} onMessage={message}
      browserMax={browserMax} onBrowserMax={setBrowserMax} />;
  } else {
    body = <SeatGrid project={project} seats={visibleSeats(layout, tileSeats(seats), selected)} layout={layout}
      selectedKey={selected.key} onFocus={focusSeat} needs={needs} />;
  }

  // #14505: maximized, the browser is the Workspace: the side columns and the seat strip fold away.
  const browserFull = browserMax && layout === "focus" && tab === "browser";

  return (
    // #14250: the area under the project header is a chrome ground; every pane is its own panel with a 6px gap.
    <ChatLinks project={project} navigate={onNavigate}>
    <div ref={workspaceRef} className="flex min-h-0 flex-1 gap-[6px] bg-[var(--v2-chrome)] p-[6px]">
      {!browserFull && <FilesColumn col={filesCol} workspace={workspaceRef} project={project} scope={scope}
        scopeName={scope ?? "project checkout"} seats={seatInfos} onPickScope={pickScope}
        onOpenFile={openFile} onOpenChange={openChange} onOpenCommit={openCommit} onShownScope={setShownScope}
        selectedPath={openedPath} onOpenConflict={openConflict} />}
      <div {...pane} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-bg)]">
        {data.error && data.seats !== null && <div role="alert" className="m-5 text-v2-base text-[var(--v2-muted)]">Can't reach the hub. {data.error}</div>}
        {!browserFull && <SeatStrip project={project} seats={seats} selectedKey={selected?.key} onSelect={setSelKey} layout={layout} onLayout={pickLayout}
          crew={crew} onDrill={() => setRecording(r => !r)} cards={data.cards} mayDo={mayDo} needs={needs} />}
        {body}
      </div>
      {!browserFull && <ChatColumn col={chatCol} workspace={workspaceRef}>
        <RightPanel project={project} seat={selected?.isHelper || selected?.agentInfo ? undefined : selected} orchestrator={seats.find(s => s.isOrchestrator)}
          changed={diff.diff?.files.length ?? 0} onNavigate={onNavigate} wake={wake} onClose={() => chatCol.setOpen(false)} />
      </ChatColumn>}
      {recording && (me
        ? <DrillMode me={me} onClose={() => setRecording(false)} />
        : <div role="alert" className="fixed bottom-14 right-4 z-40 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-3 py-2 text-v2-body text-[var(--v2-muted)]">Waiting for the signed identity before a drill can start.</div>)}
    </div>
    </ChatLinks>
  );
}
