// Trantor 2.0 shell: top bar, left rail, routed main area, plans-and-balances footer (#v2-F).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./theme.css";
import { Palette, type PaletteScope } from "../features/search/Palette";
import { backToClassic } from "./toggle";
import { isLensScreen, type Navigate, type Screen, type ScreenProps } from "./routes";
import { MODE_CONFIG, saveMode, useShellMode, type Mode } from "./shell/shellMode";
import { useShellData } from "./shell/useShellData";
import { TopBar } from "./shell/TopBar";
import { ShortcutLayer } from "./shell/ShortcutLayer";
import { keepInputsPlain } from "./shell/plainInputs";
import { AgentCliBanner } from "./shell/AgentCliBanner";
import { Rail } from "./shell/Rail";
import { BottomBar } from "./shell/BottomBar";
import { ProjectFrame } from "./shell/ProjectFrame";
import { AllProjects, ClassicLens, MessagesLens, NotWired } from "./shell/ClassicLenses";
import { DashboardScreen } from "./screens/Dashboard";
import { WorkspaceScreen } from "./screens/Workspace";
import { CodeScreen } from "./screens/Code";
import { BoardScreen } from "./screens/Board";
import { InboxScreen } from "./screens/Inbox";
import { UsageScreen } from "./screens/Usage";
import { AgentsScreen } from "./screens/Agents";
import { ExtensionsScreen } from "./screens/Extensions";
import { SettingsScreen } from "./screens/Settings";
import { StartProjectSheet } from "./screens/Projects/StartProjectSheet";
import { WakeLine, WakeNotice } from "./screens/Projects/WakeStatus";
import { useStartProject, type StartProjectDeps } from "./screens/Projects/useStartProject";

/** ⌘K anywhere opens the search palette, as in classic. */
function usePaletteKey(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

function FleetScreenView({ screen, props, projects, live, me }: {
  screen: Screen; props: ScreenProps; projects: string[]; live: string[]; me: string;
}): ReactNode {
  switch (screen) {
    case "dashboard": return <DashboardScreen {...props} />;
    case "inbox": return <InboxScreen {...props} />;
    case "messages": return <MessagesLens client={props.client} me={me} />;
    case "agents": return <AgentsScreen {...props} />;
    case "usage": return <UsageScreen {...props} />;
    case "extensions": return <ExtensionsScreen {...props} />;
    case "settings": return <SettingsScreen {...props} />;
    case "projects": return <AllProjects projects={projects} live={live} onNavigate={props.onNavigate} onStartProject={props.onStartProject} onWake={props.wake?.start} />;
    default: return null;
  }
}

function LensScreenView({ screen, props, me, notice }: { screen: Screen; props: ScreenProps; me: string; notice?: ReactNode }): ReactNode {
  if (!isLensScreen(screen)) return null;
  if (!props.project) return <NotWired title="No project" line="No projects pinned. Run trantor hub set <project> <url>." />;
  const body = screen === "workspace" ? <WorkspaceScreen {...props} />
    : screen === "code" ? <CodeScreen {...props} />
    : screen === "board" ? <BoardScreen {...props} />
    : <ClassicLens client={props.client} project={props.project} me={me} lens={screen} onNavigate={props.onNavigate} />;
  return <ProjectFrame client={props.client} project={props.project} lens={screen} onNavigate={props.onNavigate} notice={screen === "workspace" ? notice : undefined}>{body}</ProjectFrame>;
}

export function ShellV2({ startDeps }: { startDeps?: StartProjectDeps } = {}) {
  const data = useShellData();
  const { setActive } = data;
  const [screen, setScreen] = useState<Screen>("dashboard");
  const mode = useShellMode();
  const landing = MODE_CONFIG[mode].landing;
  const [palette, setPalette] = useState<PaletteScope | null>(null);
  const onNavigate: Navigate = useCallback((next, project) => {
    if (project) setActive(project);
    setScreen(next);
  }, [setActive]);
  // #14070: a mode moves the project on screen to its own landing lens; Developer also leaves a fleet screen for the code.
  const onMode = (next: Mode) => {
    if (next === mode || MODE_CONFIG[next].unavailable) return;
    saveMode(next);
    if (data.active && (isLensScreen(screen) || next === "developer")) setScreen(MODE_CONFIG[next].landing);
  };
  const togglePalette = useCallback(() => setPalette(cur => (cur ? null : { kind: "global" })), []);
  usePaletteKey(togglePalette);
  const start = useStartProject({ addProject: data.addProject, onNavigate, deps: startDeps });
  // #14271: one wake path for the Start buttons and the chat panel; it also makes the project active and opens its Workspace.
  const wakeProject = useCallback((project: string) => { void start.retry(project); onNavigate("workspace", project); }, [start, onNavigate]);
  const wake = { wakes: start.wakes, start: wakeProject };
  const props: ScreenProps = { client: data.client, project: data.active, onNavigate, onStartProject: start.startProject, wake };
  const notice = data.active ? (
    <WakeLine project={data.active} state={start.wakes.get(data.active)} startedAt={start.wakeStarts.get(data.active)}
      hint={start.planHint === data.active} onRetry={p => void start.retry(p)} onDismiss={start.dismissWake}
      onDismissHint={start.dismissHint} />
  ) : null;
  useEffect(() => keepInputsPlain(document.body), []);
  return (
    <div className="v2-root flex flex-col" {...start.rootProps}>
      <TopBar projects={data.projects} project={data.active} onProject={p => onNavigate(isLensScreen(screen) ? screen : landing, p)}
        mode={mode} onMode={onMode}
        onSearch={() => setPalette(data.active ? { kind: "project", project: data.active } : { kind: "global" })}
        needsYou={data.needsYou} me={data.me} onNavigate={onNavigate} onStartProject={start.startProject} onBackToClassic={backToClassic}
        notice={<WakeNotice wakes={start.wakes} wakeStarts={start.wakeStarts} activeProject={data.active} />} />
      <AgentCliBanner />
      <div className="flex min-h-0 flex-1">
        <Rail screen={screen} project={data.active} live={data.live} unread={data.unread} needsYou={data.needsYou} update={data.update} onNavigate={onNavigate} onWake={wakeProject} />
        <main data-screen={screen} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {isLensScreen(screen)
            ? <LensScreenView screen={screen} props={props} me={data.me} notice={notice} />
            : <FleetScreenView screen={screen} props={props} projects={data.projects} live={data.live} me={data.me} />}
        </main>
      </div>
      <BottomBar client={data.client} onOpenUsage={() => onNavigate("usage")} />
      {start.open && (
        <StartProjectSheet devRoot={start.devRoot} deps={start.deps} onClose={start.close} onMade={start.onMade} onCreated={start.onCreated} />
      )}
      {palette && (
        <Palette scope={palette} projects={data.projects}
          searchProjects={palette.kind === "project" ? [palette.project] : data.projects}
          onClose={() => setPalette(null)}
          onJumpProject={p => { setPalette(null); onNavigate(landing, p); }}
          onOpenCard={p => { setPalette(null); onNavigate("board", p); }} />
      )}
      <ShortcutLayer project={data.active} screen={screen} mode={mode} onMode={onMode} onNavigate={onNavigate} onSearch={togglePalette} />
    </div>
  );
}
