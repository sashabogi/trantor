// Trantor 2.0 shell: top bar, left rail, routed main area, plans-and-balances footer (#v2-F).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./theme.css";
import { Palette, type PaletteScope } from "../features/search/Palette";
import { backToClassic } from "./toggle";
import { isLensScreen, readMode, saveMode, type Mode, type Navigate, type Screen, type ScreenProps } from "./routes";
import { useShellData } from "./shell/useShellData";
import { TopBar } from "./shell/TopBar";
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
    case "projects": return <AllProjects projects={projects} live={live} onNavigate={props.onNavigate} />;
    default: return null;
  }
}

function LensScreenView({ screen, props, me }: { screen: Screen; props: ScreenProps; me: string }): ReactNode {
  if (!isLensScreen(screen)) return null;
  if (!props.project) return <NotWired title="No project" line="No projects pinned. Run trantor hub set <project> <url>." />;
  const body = screen === "workspace" ? <WorkspaceScreen {...props} />
    : screen === "code" ? <CodeScreen {...props} />
    : screen === "board" ? <BoardScreen {...props} />
    : <ClassicLens client={props.client} project={props.project} me={me} lens={screen} onNavigate={props.onNavigate} />;
  return <ProjectFrame client={props.client} project={props.project} lens={screen} onNavigate={props.onNavigate}>{body}</ProjectFrame>;
}

export function ShellV2() {
  const data = useShellData();
  const { setActive } = data;
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [mode, setMode] = useState<Mode>(readMode);
  const [palette, setPalette] = useState<PaletteScope | null>(null);
  const onNavigate: Navigate = useCallback((next, project) => {
    if (project) setActive(project);
    setScreen(next);
  }, [setActive]);
  const togglePalette = useCallback(() => setPalette(cur => (cur ? null : { kind: "global" })), []);
  usePaletteKey(togglePalette);
  const props: ScreenProps = { client: data.client, project: data.active, onNavigate };
  return (
    <div className="v2-root flex flex-col">
      <TopBar projects={data.projects} project={data.active} onProject={p => onNavigate(isLensScreen(screen) ? screen : "workspace", p)}
        mode={mode} onMode={m => { setMode(m); saveMode(m); }}
        onSearch={() => setPalette(data.active ? { kind: "project", project: data.active } : { kind: "global" })}
        needsYou={data.needsYou} me={data.me} onNavigate={onNavigate} onBackToClassic={backToClassic} />
      <div className="flex min-h-0 flex-1">
        <Rail screen={screen} project={data.active} live={data.live} unread={data.unread} needsYou={data.needsYou} onNavigate={onNavigate} />
        <main data-screen={screen} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {isLensScreen(screen)
            ? <LensScreenView screen={screen} props={props} me={data.me} />
            : <FleetScreenView screen={screen} props={props} projects={data.projects} live={data.live} me={data.me} />}
        </main>
      </div>
      <BottomBar client={data.client} onOpenUsage={() => onNavigate("usage")} />
      {palette && (
        <Palette scope={palette} projects={data.projects}
          searchProjects={palette.kind === "project" ? [palette.project] : data.projects}
          onClose={() => setPalette(null)}
          onJumpProject={p => { setPalette(null); onNavigate("workspace", p); }}
          onOpenCard={p => { setPalette(null); onNavigate("board", p); }} />
      )}
    </div>
  );
}
