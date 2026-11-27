// Trantor 2.0 shell: top bar, left rail, routed main area, plans-and-balances footer (#v2-F).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { trantorCliCompatibility, type TrantorCliCompatibility } from "../shared/api/client";
import { OnboardingFlow } from "../features/onboarding/OnboardingFlow";
import { ONBOARDING_REOPENED, onboardingApi } from "../features/onboarding/onboardingApi";
import { shouldShowOnboarding, type OnboardingState } from "../features/onboarding/onboardingState";
import { useLocalHub } from "./shell/useLocalHub";
import "./theme.css";
import { Palette, type PaletteScope } from "../features/search/Palette";
import { backToClassic } from "./toggle";
import { openBoardCard } from "./shell/boardIntent";
import { isLensScreen, type FleetScreen, type LensScreen, type Navigate, type Screen, type ScreenProps } from "./routes";
import { MODE_CONFIG, saveMode, useShellMode, type Mode } from "./shell/shellMode";
import { fleetScreenOf, initialScreen, projectLensGet, rememberScreen, SCREEN_KEY } from "./shell/screenState";
import { useShellData } from "./shell/useShellData";
import { TopBar } from "./shell/TopBar";
import { ShortcutLayer } from "./shell/ShortcutLayer";
import { keepInputsPlain } from "./shell/plainInputs";
import { AgentCliBanner } from "./shell/AgentCliBanner";
import { Rail } from "./shell/Rail";
import { BottomBar } from "./shell/BottomBar";
import { CardSheet } from "./shell/CardSheet";
import { ProjectFrame } from "./shell/ProjectFrame";
import { AllProjects, ClassicLens, MessagesLens } from "./shell/ClassicLenses";
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

export function LensScreenView({ screen, props, me, notice }: { screen: Screen; props: ScreenProps; me: string; notice?: ReactNode }): ReactNode {
  if (!isLensScreen(screen)) return null;
  if (!props.project) {
    return (
      <div className="px-5 py-6">
        <h2 className="m-0 text-v2-title font-semibold">No projects yet.</h2>
        <p className="mt-1 text-v2-base text-[var(--v2-muted)]">Create a repo or open one you already have.</p>
        {props.onStartProject && (
          <button type="button" onClick={props.onStartProject}
            className="mt-3 rounded-lg border-0 bg-[var(--v2-accent)] px-4 py-2 text-v2-base font-semibold text-[var(--v2-ink)]">
            Start a project
          </button>
        )}
      </div>
    );
  }
  const body = screen === "workspace" ? <WorkspaceScreen {...props} />
    : screen === "code" ? <CodeScreen {...props} />
    : screen === "board" ? <BoardScreen {...props} />
    : <ClassicLens client={props.client} project={props.project} me={me} lens={screen} onNavigate={props.onNavigate} />;
  return <ProjectFrame client={props.client} project={props.project} lens={screen} onNavigate={props.onNavigate} notice={screen === "workspace" ? notice : undefined}>{body}</ProjectFrame>;
}

/** The first-run gate and the CLI banner, the way the classic shell mounts them (#14322). */
function useOnboardingGate() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [forced, setForced] = useState(false);
  useEffect(() => {
    const read = () => { onboardingApi.get().then(setState).catch(() => {}); };
    read();
    // "Show onboarding again" in Settings reopens it from disk and says so with this event.
    const reopened = () => { onboardingApi.get().then(next => { setState(next); setForced(true); }).catch(() => {}); };
    window.addEventListener(ONBOARDING_REOPENED, reopened);
    return () => window.removeEventListener(ONBOARDING_REOPENED, reopened);
  }, []);
  const open = () => { setState({ flowVersion: 1, closedAt: null, lastCompletedStep: null }); setForced(true); };
  const close = () => { setState(cur => cur && { ...cur, closedAt: Date.now() }); setForced(false); };
  return { show: shouldShowOnboarding(state), forced, open, close };
}

function TrantorCliBanner() {
  const [compat, setCompat] = useState<TrantorCliCompatibility | null>(null);
  useEffect(() => {
    let alive = true;
    void trantorCliCompatibility().then(c => { if (alive) setCompat(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!compat || compat.compatible || !compat.reason) return null;
  return (
    <div role="alert" data-trantor-cli-banner
      className="shrink-0 border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-4 py-2 text-center text-v2-body text-[var(--v2-warn)]">
      {compat.reason}
    </div>
  );
}

export function ShellV2({ startDeps }: { startDeps?: StartProjectDeps } = {}) {
  const data = useShellData();
  const localHub = useLocalHub();
  const onboarding = useOnboardingGate();
  const { setActive } = data;
  const [screen, setScreen] = useState<Screen>("dashboard");
  // #14513: reopen where the operator left it — the last fleet screen, else the active
  // project's remembered lens — once the project list settles, so a stale saved project
  // never lends its lens. Screen stays "dashboard" until then.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || !data.projects.length) return;
    let alive = true;
    const apply = (lens: LensScreen | null) => {
      if (!alive) return;
      setRestored(true);
      let fleet: FleetScreen | null = null;
      try { fleet = fleetScreenOf(localStorage.getItem(SCREEN_KEY)); } catch { /* storage blocked */ }
      const next = initialScreen(fleet, lens, data.active);
      setScreen(cur => (cur === "dashboard" ? next : cur));
    };
    if (!data.active) { apply(null); return; }
    void projectLensGet(data.active).then(apply);
    return () => { alive = false; };
  }, [restored, data.projects.length, data.active]);
  const mode = useShellMode();
  const landing = MODE_CONFIG[mode].landing;
  const [palette, setPalette] = useState<PaletteScope | null>(null);
  const onNavigate: Navigate = useCallback((next, project) => {
    if (project) setActive(project);
    // #14513: every navigation is where a relaunch must land.
    rememberScreen(next, project ?? data.active);
    setScreen(next);
  }, [setActive, data.active]);
  // #14070: a mode moves the project on screen to its own landing lens; Developer also leaves a fleet screen for the code.
  const onMode = (next: Mode) => {
    if (next === mode || MODE_CONFIG[next].unavailable) return;
    saveMode(next);
    if (data.active && (isLensScreen(screen) || next === "developer")) {
      rememberScreen(MODE_CONFIG[next].landing, data.active);
      setScreen(MODE_CONFIG[next].landing);
    }
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
      onDismissHint={start.dismissHint} onNavigate={onNavigate} />
  ) : null;
  useEffect(() => keepInputsPlain(document.body), []);
  return (
    <div className="v2-root flex flex-col" {...start.rootProps}>
      <TopBar projects={data.projects} project={data.active} onProject={p => onNavigate(isLensScreen(screen) ? screen : landing, p)}
        mode={mode} onMode={onMode}
        onSearch={() => setPalette(data.active ? { kind: "project", project: data.active } : { kind: "global" })}
        needsYou={data.needsYou} me={data.me} onNavigate={onNavigate} onStartProject={start.startProject} onBackToClassic={backToClassic}
        notice={<WakeNotice wakes={start.wakes} wakeStarts={start.wakeStarts} activeProject={data.active} />} />
      <TrantorCliBanner />
      <AgentCliBanner />
      <div className="flex min-h-0 flex-1">
        <Rail screen={screen} project={data.active} live={data.live} unread={data.unread} needsYou={data.needsYou} update={data.update} onNavigate={onNavigate} onWake={wakeProject} />
        <main data-screen={screen} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {isLensScreen(screen)
            ? <LensScreenView screen={screen} props={props} me={data.me} notice={notice} />
            : <FleetScreenView screen={screen} props={props} projects={data.projects} live={data.live} me={data.me} />}
        </main>
      </div>
      <BottomBar client={data.client} onOpenUsage={() => onNavigate("usage")} localHub={localHub} onSetup={onboarding.open} />
      {start.open && (
        <StartProjectSheet devRoot={start.devRoot} deps={start.deps} onClose={start.close} onMade={start.onMade} onCreated={start.onCreated} />
      )}
      {palette && (
        <Palette scope={palette} projects={data.projects}
          searchProjects={palette.kind === "project" ? [palette.project] : data.projects}
          onClose={() => setPalette(null)}
          onJumpProject={p => { setPalette(null); onNavigate(landing, p); }}
          onOpenCard={(p, id) => { setPalette(null); openBoardCard(p, id); onNavigate("board", p); }} />
      )}
      {onboarding.show && (
        <OnboardingFlow me={data.me} project={data.active || data.projects[0] || ""} forced={onboarding.forced}
          onCliInstalled={localHub.retry} onClose={onboarding.close} />
      )}
      <CardSheet client={data.client} />
      <ShortcutLayer project={data.active} screen={screen} mode={mode} onMode={onMode} onNavigate={onNavigate} onSearch={togglePalette} />
    </div>
  );
}
