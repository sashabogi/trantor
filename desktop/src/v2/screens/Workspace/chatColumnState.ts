// Width and open state of the Workspace chat column, persisted per user (#13987 drill).
import { useCallback, useState } from "react";

export const WIDTH_KEY = "trantor.v2.workspace.chatWidth";
export const OPEN_KEY = "trantor.v2.workspace.chatOpen";
export const MIN_WIDTH = 320;
export const DEFAULT_WIDTH = 400;
export const RAIL_WIDTH = 44;
export const KEY_STEP = 16;
export const MAX_FRACTION = 0.6;

/** The widest the column may be: 60% of the workspace, never below the minimum. */
export function maxWidthFor(workspace: number): number {
  return Math.max(MIN_WIDTH, Math.floor(workspace * MAX_FRACTION));
}

export const clampWidth = (w: number, workspace: number): number =>
  Math.min(maxWidthFor(workspace), Math.max(MIN_WIDTH, Math.round(w)));

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) !== "false"; } catch { return true; }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice lasts the session */ }
}

export function useChatColumn() {
  const [width, setWidthState] = useState(readWidth);
  const [open, setOpenState] = useState(readOpen);
  const setWidth = useCallback((w: number) => setWidthState(w), []);
  const commitWidth = useCallback((w: number) => { setWidthState(w); write(WIDTH_KEY, String(w)); }, []);
  const setOpen = useCallback((o: boolean) => { setOpenState(o); write(OPEN_KEY, String(o)); }, []);
  return { width, setWidth, commitWidth, open, setOpen };
}
