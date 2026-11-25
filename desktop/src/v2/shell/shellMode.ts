// The shell's mode: one stored choice every screen reads, and what each mode changes (#14070).
import { useSyncExternalStore } from "react";
import type { LensScreen } from "../routes";

export type Mode = "orchestrator" | "mixed" | "developer";
export const MODE_KEY = "trantor.v2.mode";

export type ModeConfig = {
  /** The lens a project opens on. */
  landing: LensScreen;
  /** Lens tabs, left to right. */
  lenses: readonly LensScreen[];
  /** Where this mode remembers an expanded main rail; every mode starts on icons. */
  railKey: string;
  /** The project header shrinks to the lens tabs row, so the editor gets the height. */
  compactHeader: boolean;
  /** Push and discard may act on the operator's own checkout, not only seat worktrees. */
  ownCheckoutMutations: boolean;
  /** Why the mode cannot be picked yet; absent when it can. */
  unavailable?: string;
};

const ORCHESTRATOR: ModeConfig = {
  landing: "workspace",
  lenses: ["workspace", "code", "graph", "board", "feed", "bus"],
  railKey: "trantor.v2.rail.expanded",
  compactHeader: false,
  ownCheckoutMutations: false,
};

const MIXED: ModeConfig = { ...ORCHESTRATOR, unavailable: "Mixed mode comes next: it needs keep or undo per change and approval rules on the hub" };

const DEVELOPER: ModeConfig = {
  landing: "code",
  lenses: ["code", "workspace", "graph", "board", "feed", "bus"],
  railKey: "trantor.v2.rail.expanded.developer",
  compactHeader: true,
  ownCheckoutMutations: true,
};

export const MODE_CONFIG = { orchestrator: ORCHESTRATOR, mixed: MIXED, developer: DEVELOPER } satisfies Record<Mode, ModeConfig>;

// Storage blocked: the choice lasts the session.
let sessionMode: Mode = "orchestrator";
const listeners = new Set<() => void>();

/** The stored mode. A mode that cannot be picked reads as Orchestrator. */
export function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "developer" ? "developer" : "orchestrator";
  } catch { return sessionMode; }
}

export function saveMode(m: Mode) {
  if (MODE_CONFIG[m].unavailable) return;
  sessionMode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch { /* kept in sessionMode */ }
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => { listeners.delete(notify); window.removeEventListener("storage", notify); };
}

/** The mode on screen; every component that calls this follows the top bar's switch. */
export function useShellMode(): Mode {
  return useSyncExternalStore(subscribe, readMode);
}

/** The lens a project opens on right now, for click handlers outside the shell. */
export const landingLens = (): LensScreen => MODE_CONFIG[readMode()].landing;
