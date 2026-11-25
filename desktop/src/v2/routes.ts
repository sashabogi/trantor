// What the shell can show, and which screens live inside a project (#v2-F).
import type { HubClient } from "../shared/api/client";

export const LENS_SCREENS = ["workspace", "code", "graph", "board", "feed", "bus", "browser"] as const;
export type LensScreen = (typeof LENS_SCREENS)[number];

export const FLEET_SCREENS = ["dashboard", "inbox", "messages", "agents", "usage", "extensions", "settings", "projects"] as const;
export type FleetScreen = (typeof FLEET_SCREENS)[number];

export type Screen = FleetScreen | LensScreen;

/** Go to a screen; a project argument switches the active project first. */
export type Navigate = (screen: Screen, project?: string) => void;

/** The contract every screen component receives from ShellV2. */
export type ScreenProps = {
  client: HubClient;
  /** The active project, or "" when none is pinned yet. */
  project: string;
  onNavigate: Navigate;
  /** Opens the Start a project sheet (#13984). */
  onStartProject?: () => void;
};

export const LENS_LABEL = {
  workspace: "Workspace", code: "Code", graph: "Graph", board: "Board", feed: "Feed", bus: "Bus", browser: "Browser",
} as const satisfies Record<LensScreen, string>;

export function isLensScreen(s: Screen): s is LensScreen {
  return LENS_SCREENS.some(l => l === s);
}

export type Mode = "orchestrator" | "mixed" | "developer";
export const MODE_KEY = "trantor.v2.mode";

export function readMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "mixed" || m === "developer" ? m : "orchestrator";
  } catch { return "orchestrator"; }
}

export function saveMode(m: Mode) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked: the mode lasts the session */ }
}
