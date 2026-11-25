// Trantor 2.0 Code and Git (#13988): icon bar, tabs, source control with history and changes, branch
// picker, PR and merge-conflict tabs. Real data from the classic git and file commands only.
// #14241: the source tab's list runs full height beside the panel column, so its shared state
// (the picked file, the chips, the history rows) lives here instead of inside SourceControlTab.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { takeOpenIntent, watchOpenIntent } from "../../shell/openIntent";
import type { Card } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { BottomPanel } from "../../ui/BottomPanel";
import { Terminals } from "../../ui/BottomPanel/Terminals";
import { Output } from "../../ui/BottomPanel/Output";
import { Problems } from "../../ui/BottomPanel/Problems";
import { conflictPaths } from "../../../features/code/gitApi";
import type { ScreenProps } from "../../routes";
import { NotWiredBlock } from "./parts";
import type { PickerActions } from "./BranchPicker";
import { ChatRail } from "./ChatRail";
import { ConflictView } from "./ConflictView";
import { IconBar, type SideView } from "./IconBar";
import { Sidebar } from "./Sidebar";
import { SourceDetail, SourceListColumn, changeChips, type ChatActs } from "./SourceControlTab";
import type { ChipFile } from "./DiffPane";
import { TabBar, type CodeTab } from "./TabBar";
import { Toolbar, type ScmView } from "./Toolbar";
import { pickChange, sidebarVisible, toRow, type HistoryRow } from "./model";
import { useScopeGit, type ScopeSnapshot, type ScopeState } from "./useScopeGit";
import { useSeats } from "./useSeats";
import { useCodeCommands } from "./useCodeCommands";
import { branchMutationRefusal } from "./scopeGitApi";
import { useShellMode } from "../../shell/shellMode";
import { useTabs } from "./useTabs";

const FileEditor = lazy(() => import("./FileEditor"));

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };

export function CodeScreen({ client, project, onNavigate }: ScreenProps) {
  const [scope, setScope] = useState<string | null>(null);
  const { state, refresh } = useScopeGit(project, scope);
  const { seats, peers } = useSeats(client, project);
  const cards = useTasks(client, project);
  const tabs = useTabs(project);
  const [side, setSide] = useState<SideView>("source");
  const [override, setOverride] = useState(false);
  const [viewPick, setViewPick] = useState<ScmView | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatWant, setChatWant] = useState<string | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changeFocus, setChangeFocus] = useState<string | null>(null);
  // #14241: the picked change lifts here so the list column and the diff column share it.
  const [picked, setPicked] = useState<string | null>(null);
  const snap = state.kind === "ok" ? state.snap : null;
  const view: ScmView = viewPick ?? (snap?.seatBacked ? "history" : "changes");
  const visible = sidebarVisible(tabs.active.kind, override);
  const chips = useMemo(() => (snap ? changeChips(snap) : []), [snap]);
  const selectedChange = useMemo(() => pickChange(chips.map(c => c.path), picked, changeFocus), [chips, picked, changeFocus]);
  const seatNames = useMemo(() => seats.map(s => s.seat), [seats]);
  const rowCtx = useMemo(() => ({ seats: seatNames, branch: snap?.branch ?? null }), [seatNames, snap]);
  const rows = useMemo(() => (snap?.log ?? []).map(c => toRow(c, rowCtx)), [snap, rowCtx]);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>(rows);

  const addToChat = useCallback((text: string) => { setDraft(d => (d.trim() ? `${d}\n${text}` : text)); setChatOpen(true); }, []);
  const mode = useShellMode();
  const branchRefusal = branchMutationRefusal(scope, mode) ?? (seats.find(seat => seat.seat === scope)?.presence === "working" ? `${scope} is working; change its worktree after the turn ends` : null);
  const acts = useMemo(() => ({ addToChat, copy, branchRefusal }), [addToChat, branchRefusal]);
  const [reveal, setReveal] = useState<{ tab: string; line: number; column?: number; nonce: number } | null>(null);
  const openFile = (path: string, line?: number, column?: number) => {
    const id = `file:${scope ?? ""}:${path}`;
    tabs.open({ id, kind: "file", label: base(path), scope, path });
    // A fresh nonce lets a second click on the same line reveal it again (#14074).
    if (line) setReveal({ tab: id, line, column, nonce: Date.now() });
  };
  const openConflict = (path: string | null) => { setConflictPath(path); tabs.open({ id: "conflict", kind: "conflict", label: "Merge conflicts", scope }); };
  const pick = (seat: string | null) => { setScope(seat); setKey(null); tabs.activate("source"); };
  const openChange = (path: string) => { setChangeFocus(path); setViewPick("changes"); tabs.activate("source"); };
  const openCommit = (sha: string) => { setKey(sha); setViewPick("history"); tabs.activate("source"); };
  // #13987/#14044 drill: the Workspace source control sidebar leaves a note here; take it once per project.
  const { open: openTab, activate: activateTab } = tabs;
  useEffect(() => {
    const apply = () => {
      const intent = takeOpenIntent(project);
      if (!intent) return;
      const seat = intent.seat ?? null;
      setScope(seat);
      setKey(null);
      if (intent.kind === "file") openTab({ id: `file:${seat ?? ""}:${intent.path}`, kind: "file", label: base(intent.path), scope: seat, path: intent.path });
      else if (intent.kind === "change") { setChangeFocus(intent.path); setViewPick("changes"); activateTab("source"); setWantChange(intent.path); }
      else if (intent.kind === "commit") { setKey(intent.sha); setViewPick("history"); activateTab("source"); }
      else activateTab("source");
    };
    apply();
    return watchOpenIntent(project, apply);
  }, [project, openTab, activateTab]);
  // #14084 drill: a file with no uncommitted change has no diff to land on, so its tab opens instead of an unrelated change.
  const [wantChange, setWantChange] = useState<string | null>(null);
  useEffect(() => {
    if (!wantChange || !snap) return;
    setWantChange(null);
    if (!snap.status.some(s => s.path === wantChange)) openTab({ id: `file:${scope ?? ""}:${wantChange}`, kind: "file", label: base(wantChange), scope, path: wantChange });
  }, [wantChange, snap, scope, openTab]);
  const picker: PickerActions = {
    onCheckout: () => pick(null),
    onSeat: seat => pick(seat),
    onCompare: seat => { pick(seat); setViewPick("history"); setKey("unlanded"); },
    onMessage: seat => { setChatWant(seat); setChatOpen(true); },
    onCopy: copy,
  };
  // A seat that is not offline can take a message (#14073).
  const liveSeats = useMemo(() => seats.filter(s => s.presence !== "offline"), [seats]);
  const onIcon = (v: SideView) => {
    if (v === "source") { tabs.activate("source"); setSide("source"); setOverride(false); return; }
    setSide(v);
    setOverride(true);
  };
  useCodeCommands({ project, scope, refresh, onError: setNotice, showSearch: () => { setSide("search"); setOverride(true); } });
  const changeCount = snap ? new Set(snap.status.map(s => s.path)).size : 0;

  return (
    // #14250: the screen is a chrome ground; the icon bar, sidebar, editor column, bottom panel and chat are panels.
    <div className="flex min-h-[600px] min-w-0 flex-1 gap-[6px] bg-[var(--v2-chrome)] p-[6px]" data-testid="code-screen">
      <IconBar active={side} folded={!visible} onPick={onIcon} changeCount={changeCount} />
      {visible && (
        <Sidebar view={side} client={client} project={project} scope={scope} seats={seats} state={state} selected={changeFocus}
          onOpenFile={openFile} onOpenChange={openChange} onMutated={refresh} onOpenSource={() => { tabs.activate("source"); setOverride(false); }}
          onOpenCommit={openCommit} onPickSeat={pick} onOpenConflict={openConflict} />
      )}
      {/* #14241: on the source tab the changes list is its own full-height panel; the bottom panel sits under the editor only. */}
      {tabs.active.kind === "source" && snap && (
        <div data-testid="source-list-panel" className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-bg)]">
          <SourceListColumn project={project} snap={snap} view={view} seats={seatNames} rows={rows} onRows={setHistoryRows}
            selected={selectedChange} onSelect={setPicked} selectedKey={key} onSelectKey={setKey}
            onMutated={refresh} onOpenConflict={openConflict} />
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-[6px]">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-bg)]">
          <TabBar tabs={tabs.tabs} activeId={tabs.activeId} sidebarFolded={!visible} dirty={tabs.dirty} confirmId={tabs.confirmId}
            onActivate={tabs.activate} onRequestClose={tabs.requestClose} onConfirmClose={tabs.confirmClose} onCancelClose={tabs.cancelClose}
            onShowSidebar={() => { setSide("source"); setOverride(true); }} onNew={() => { setSide("search"); setOverride(true); }} />
          <Toolbar project={project} snap={snap} seats={seats} scope={scope} acts={picker} view={view} onView={setViewPick} onMutated={refresh} onError={setNotice} onOpenConflict={openConflict} />
          {notice && <button type="button" role="alert" onClick={() => setNotice(null)} title="Dismiss" className="border-0 border-b border-[var(--v2-edge)] bg-[var(--v2-bad-soft)] px-4 py-1.5 text-left text-v2-body text-[var(--v2-bad)]">{notice}</button>}
          <div className="flex min-h-0 min-w-0 flex-1">
            {/* #14071: the tab's body always fills the column, so short content still stretches to the panel. */}
            <div data-testid="code-main" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
              <Main tab={tabs.active} client={client} project={project} snap={snap} state={state} view={view} cards={cards}
                chips={chips} selectedChange={selectedChange} onPickChange={setPicked} historyRows={historyRows}
                selectedKey={key} onSelectKey={setKey} acts={acts} onNavigate={onNavigate} onMutated={refresh} onOpenFile={openFile}
                onOpenConflict={openConflict} conflictPath={conflictPath} reveal={reveal} markDirty={tabs.markDirty} onError={setNotice}
                liveSeats={liveSeats} onAsk={addToChat} onSendToSeat={(seat, text) => { picker.onMessage(seat); addToChat(text); }} />
            </div>
          </div>
        </div>
        {/* #14080: keyed by project so one project never shows another project's shell. */}
        <BottomPanel terminal={<Terminals key={project} project={project} />} output={<Output />}
          problems={<Problems project={project} seat={scope} onOpen={openFile} />} />
      </div>
      <ChatRail client={client} project={project} peers={peers} open={chatOpen} onToggle={() => setChatOpen(o => !o)} draft={draft} onDraft={setDraft} want={chatWant} />
    </div>
  );
}

type MainProps = {
  tab: CodeTab; client: ScreenProps["client"]; project: string; snap: ScopeSnapshot | null; state: ScopeState; view: ScmView; cards: Card[];
  chips: ChipFile[]; selectedChange: string | null; onPickChange: (path: string | null) => void; historyRows: HistoryRow[];
  selectedKey: string | null; onSelectKey: (k: string) => void; acts: ChatActs; onNavigate: ScreenProps["onNavigate"];
  onMutated: () => void; onOpenFile: (p: string) => void; onOpenConflict: (p: string | null) => void; conflictPath: string | null;
  reveal: { tab: string; line: number; column?: number; nonce: number } | null;
  markDirty: (id: string, dirty: boolean) => void;
  liveSeats: { seat: string }[]; onAsk: (text: string) => void; onSendToSeat: (seat: string, text: string) => void; onError: (message: string) => void;
};

function Main(p: MainProps) {
  if (p.tab.kind === "file" && p.tab.path) {
    return (
      <Suspense fallback={<div className="px-4 py-6 text-v2-base text-[var(--v2-muted)]">Opening the editor</div>}>
        {/* #14072: keyed by tab so a switch remounts cleanly and the draft resumes from the tab's cache. */}
        <FileEditor key={p.tab.id} project={p.project} scope={p.tab.scope} path={p.tab.path} onOpenGraph={() => p.onNavigate("graph")}
          reveal={p.reveal && p.reveal.tab === p.tab.id ? p.reveal : undefined} headRev={p.snap?.log[0]?.sha ?? null}
          onDirty={d => p.markDirty(p.tab.id, d)} onSaved={p.onMutated}
          seats={p.liveSeats} onAsk={p.onAsk} onSendToSeat={p.onSendToSeat} />
      </Suspense>
    );
  }
  if (p.state.kind === "error") return <div className="p-4"><NotWiredBlock title="Git could not be read for this view" line={p.state.reason} /></div>;
  if (!p.snap) return <div className="px-4 py-6 text-v2-base text-[var(--v2-muted)]">Reading git</div>;
  if (p.tab.kind === "conflict") {
    return <ConflictView project={p.project} snap={p.snap} path={p.conflictPath ?? conflictPaths(p.snap.status)[0] ?? null} onPick={path => p.onOpenConflict(path)} onResolved={p.onMutated} />;
  }
  return <SourceDetail project={p.project} snap={p.snap} view={p.view} cards={p.cards}
    chips={p.chips} selected={p.selectedChange} onPick={p.onPickChange} historyRows={p.historyRows}
    selectedKey={p.selectedKey} onSelectKey={p.onSelectKey} acts={p.acts} onNavigate={p.onNavigate}
    onMutated={p.onMutated} onError={p.onError} onOpenFile={p.onOpenFile} />;
}
