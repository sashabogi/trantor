// Trantor 2.0 Code and Git (#13988): icon bar, tabs, source control with history and changes, branch
// picker, PR and merge-conflict tabs. Real data from the classic git and file commands only.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { takeOpenIntent } from "../../shell/openIntent";
import type { Card } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { BottomPanel } from "../../ui/BottomPanel";
import { conflictPaths } from "../../../features/code/gitApi";
import type { ScreenProps } from "../../routes";
import { NotWiredBlock } from "./parts";
import type { PickerActions } from "./BranchPicker";
import { ChatRail } from "./ChatRail";
import { ConflictView } from "./ConflictView";
import { IconBar, type SideView } from "./IconBar";
import { PrTab } from "./PrTab";
import { Sidebar } from "./Sidebar";
import { SourceControlTab, type ChatActs } from "./SourceControlTab";
import { TabBar, type CodeTab } from "./TabBar";
import { Toolbar, type ScmView } from "./Toolbar";
import { sidebarVisible } from "./model";
import { useScopeGit, type ScopeSnapshot, type ScopeState } from "./useScopeGit";
import { useSeats } from "./useSeats";
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
  const snap = state.kind === "ok" ? state.snap : null;
  const view: ScmView = viewPick ?? (snap?.seatBacked ? "history" : "changes");
  const visible = sidebarVisible(tabs.active.kind, override);

  const addToChat = useCallback((text: string) => { setDraft(d => (d.trim() ? `${d}\n${text}` : text)); setChatOpen(true); }, []);
  const acts = useMemo(() => ({ addToChat, copy }), [addToChat]);
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
    const intent = takeOpenIntent(project);
    if (!intent) return;
    const seat = intent.seat ?? null;
    setScope(seat);
    setKey(null);
    if (intent.kind === "file") openTab({ id: `file:${seat ?? ""}:${intent.path}`, kind: "file", label: base(intent.path), scope: seat, path: intent.path });
    else if (intent.kind === "change") { setChangeFocus(intent.path); setViewPick("changes"); activateTab("source"); }
    else if (intent.kind === "commit") { setKey(intent.sha); setViewPick("history"); activateTab("source"); }
    else activateTab("source");
  }, [project, openTab, activateTab]);
  const picker: PickerActions = {
    onCheckout: () => pick(null),
    onSeat: seat => pick(seat),
    onCompare: seat => { pick(seat); setViewPick("history"); setKey("unlanded"); },
    onOpenPr: seat => tabs.open({ id: `pr:${seat}`, kind: "pr", label: `${seat} into main`, scope: seat }),
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
  const changeCount = snap ? new Set(snap.status.map(s => s.path)).size : 0;

  return (
    <div className="flex min-h-[600px] min-w-0 flex-1" data-testid="code-screen">
      <IconBar active={side} folded={!visible} onPick={onIcon} changeCount={changeCount} />
      {visible && (
        <Sidebar view={side} client={client} project={project} scope={scope} seats={seats} state={state} selected={changeFocus}
          onOpenFile={openFile} onOpenChange={openChange} onMutated={refresh} onOpenSource={() => { tabs.activate("source"); setOverride(false); }}
          onOpenCommit={openCommit} onPickSeat={pick} onOpenConflict={openConflict} />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar tabs={tabs.tabs} activeId={tabs.activeId} sidebarFolded={!visible} dirty={tabs.dirty} confirmId={tabs.confirmId}
          onActivate={tabs.activate} onRequestClose={tabs.requestClose} onConfirmClose={tabs.confirmClose} onCancelClose={tabs.cancelClose}
          onShowSidebar={() => { setSide("source"); setOverride(true); }} onNew={() => { setSide("search"); setOverride(true); }} />
        <Toolbar project={project} snap={snap} seats={seats} scope={scope} acts={picker} view={view} onView={setViewPick} onMutated={refresh} onError={setNotice} />
        {notice && <button type="button" role="alert" onClick={() => setNotice(null)} title="Dismiss" className="border-0 border-b border-[var(--v2-edge)] bg-[var(--v2-bad-soft)] px-4 py-1.5 text-left text-[12px] text-[var(--v2-bad)]">{notice}</button>}
        <Main tab={tabs.active} client={client} project={project} snap={snap} state={state} view={view} cards={cards} seats={seats.map(s => s.seat)}
          selectedKey={key} focusChange={changeFocus} onSelectKey={setKey} acts={acts} onNavigate={onNavigate} onMutated={refresh} onOpenFile={openFile}
          onOpenConflict={openConflict} conflictPath={conflictPath} reveal={reveal} markDirty={tabs.markDirty}
          liveSeats={liveSeats} onAsk={addToChat} onSendToSeat={(seat, text) => { picker.onMessage(seat); addToChat(text); }} />
        <BottomPanel />
      </div>
      <ChatRail client={client} project={project} peers={peers} open={chatOpen} onToggle={() => setChatOpen(o => !o)} draft={draft} onDraft={setDraft} want={chatWant} />
    </div>
  );
}

type MainProps = {
  tab: CodeTab; client: ScreenProps["client"]; project: string; snap: ScopeSnapshot | null; state: ScopeState; view: ScmView; cards: Card[];
  seats: string[]; selectedKey: string | null; focusChange: string | null; onSelectKey: (k: string) => void; acts: ChatActs; onNavigate: ScreenProps["onNavigate"];
  onMutated: () => void; onOpenFile: (p: string) => void; onOpenConflict: (p: string | null) => void; conflictPath: string | null;
  reveal: { tab: string; line: number; column?: number; nonce: number } | null;
  markDirty: (id: string, dirty: boolean) => void;
  liveSeats: { seat: string }[]; onAsk: (text: string) => void; onSendToSeat: (seat: string, text: string) => void;
};

function Main(p: MainProps) {
  if (p.tab.kind === "file" && p.tab.path) {
    return (
      <Suspense fallback={<div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">Opening the editor</div>}>
        {/* #14072: keyed by tab so a switch remounts cleanly and the draft resumes from the tab's cache. */}
        <FileEditor key={p.tab.id} project={p.project} scope={p.tab.scope} path={p.tab.path} onOpenGraph={() => p.onNavigate("graph")}
          reveal={p.reveal && p.reveal.tab === p.tab.id ? p.reveal : undefined}
          onDirty={d => p.markDirty(p.tab.id, d)} onSaved={p.onMutated}
          seats={p.liveSeats} onAsk={p.onAsk} onSendToSeat={p.onSendToSeat} />
      </Suspense>
    );
  }
  if (p.tab.kind === "pr" && p.tab.scope) return <PrTab client={p.client} project={p.project} seat={p.tab.scope} onAddToChat={p.acts.addToChat} />;
  if (p.state.kind === "error") return <div className="p-4"><NotWiredBlock title="Git could not be read for this view" line={p.state.reason} /></div>;
  if (!p.snap) return <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">Reading git</div>;
  if (p.tab.kind === "conflict") {
    return <ConflictView project={p.project} snap={p.snap} path={p.conflictPath ?? conflictPaths(p.snap.status)[0] ?? null} onPick={path => p.onOpenConflict(path)} onResolved={p.onMutated} />;
  }
  return <SourceControlTab project={p.project} snap={p.snap} view={p.view} cards={p.cards} seats={p.seats} selectedKey={p.selectedKey} focusChange={p.focusChange}
    onSelectKey={p.onSelectKey} acts={p.acts} onNavigate={p.onNavigate} onMutated={p.onMutated} onOpenFile={p.onOpenFile} onOpenConflict={p.onOpenConflict} />;
}
