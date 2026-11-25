// The commands the shell itself owns: modes, going to a screen, search, the openers and the panel toggle.
import { FLEET_SCREENS, LENS_LABEL, LENS_SCREENS, type FleetScreen, type Navigate, type Screen } from "../routes";
import { sendBottomPanel } from "../ui/BottomPanel/state";
import type { Command } from "./commands";
import type { Mode } from "./shellMode";

export type ShellCommandContext = {
  /** The active project, or "" when none is pinned. */
  project: string;
  screen: Screen;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onNavigate: Navigate;
  onSearch: () => void;
  onQuickOpen: () => void;
  onPalette: () => void;
};

const FLEET_TITLE = {
  dashboard: "Go to Dashboard", inbox: "Go to Inbox", messages: "Go to Messages", agents: "Go to Agents",
  usage: "Go to Usage and costs", extensions: "Go to Extensions", settings: "Open Settings", projects: "Go to All projects",
} satisfies Record<FleetScreen, string>;

function modeCommands(c: ShellCommandContext): Command[] {
  return [
    { id: "mode.orchestrator", title: "Switch to Orchestrator mode", group: "Mode", when: () => c.mode !== "orchestrator", run: () => c.onMode("orchestrator") },
    { id: "mode.developer", title: "Switch to Developer mode", group: "Mode", when: () => c.mode !== "developer", run: () => c.onMode("developer") },
  ];
}

function screenCommands(c: ShellCommandContext): Command[] {
  const lenses = LENS_SCREENS.map((lens): Command => ({
    id: `go.${lens}`, title: `Go to ${LENS_LABEL[lens]}`, group: "Go to",
    when: () => !!c.project && c.screen !== lens, run: () => c.onNavigate(lens),
  }));
  const fleet = FLEET_SCREENS.map((screen): Command => ({
    id: `go.${screen}`, title: FLEET_TITLE[screen], group: "Go to",
    when: () => c.screen !== screen, run: () => c.onNavigate(screen),
  }));
  return [...lenses, ...fleet];
}

function toolCommands(c: ShellCommandContext): Command[] {
  return [
    { id: "search.everywhere", title: "Search cards, messages and files", group: "Search", shortcut: "Mod+K", listOnly: true, run: c.onSearch },
    { id: "go.file", title: "Go to file", group: "Go to", shortcut: "Mod+P", run: c.onQuickOpen },
    { id: "commands.palette", title: "Show all commands", group: "Commands", shortcut: "Mod+Shift+P", run: c.onPalette },
    // The panel lives on the Code screen, so the toggle only applies there.
    { id: "view.bottomPanel", title: "Toggle bottom panel", group: "View", shortcut: "Ctrl+`", listOnly: true,
      when: () => c.screen === "code" && !!c.project, run: () => sendBottomPanel("toggle") },
  ];
}

export const shellCommands = (c: ShellCommandContext): Command[] => [...modeCommands(c), ...screenCommands(c), ...toolCommands(c)];
