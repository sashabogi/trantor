// The commands the shell itself owns: modes, going to a screen, search, the openers and the panel toggles.
import { FLEET_SCREENS, LENS_LABEL, LENS_SCREENS, type FleetScreen, type Navigate, type Screen } from "../routes";
import type { Command } from "./commands";
import { togglePanel } from "./panelSlots";
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

// #14512: the side columns live on the project screens; the bottom panel is Code-only.
const onProjectScreen = (c: ShellCommandContext): boolean =>
  !!c.project && (c.screen === "workspace" || c.screen === "code");

function panelCommands(c: ShellCommandContext): Command[] {
  return [
    // The chords run the top-bar cluster's panels through the slot each screen registered.
    { id: "view.panelLeft", title: "Toggle source control column", group: "View", shortcut: "Mod+B",
      when: () => onProjectScreen(c), run: () => { togglePanel("left"); } },
    // ⌘J joins the panel's own Ctrl+`, which the mounted bottom panel keeps handling itself.
    { id: "view.panelBottom", title: "Toggle bottom panel", group: "View", shortcut: "Mod+J",
      when: () => c.screen === "code" && !!c.project, run: () => { togglePanel("bottom"); } },
    { id: "view.panelRight", title: "Toggle chat column", group: "View", shortcut: "Mod+Alt+B",
      when: () => onProjectScreen(c), run: () => { togglePanel("right"); } },
  ];
}

function toolCommands(c: ShellCommandContext): Command[] {
  return [
    { id: "search.everywhere", title: "Search cards, messages and files", group: "Search", shortcut: "Mod+K", listOnly: true, run: c.onSearch },
    { id: "go.file", title: "Go to file", group: "Go to", shortcut: "Mod+P", run: c.onQuickOpen },
    { id: "commands.palette", title: "Show all commands", group: "Commands", shortcut: "Mod+Shift+P", run: c.onPalette },
  ];
}

export const shellCommands = (c: ShellCommandContext): Command[] =>
  [...modeCommands(c), ...screenCommands(c), ...panelCommands(c), ...toolCommands(c)];
