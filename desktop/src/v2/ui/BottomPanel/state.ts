// Bottom panel state: mode-aware defaults and per-user choices remembered across app restarts (#14071).
import { useCallback, useState } from "react";
import type { Mode } from "../../shell/shellMode";

export type BottomPanelTab = "terminal" | "output";
export const OPEN_KEY = "trantor.v2.bottomPanel.open";
export const HEIGHT_KEY = "trantor.v2.bottomPanel.height";
export const ACTIVE_TAB_KEY = "trantor.v2.bottomPanel.activeTab";
export const MAXIMISED_KEY = "trantor.v2.bottomPanel.maximised";
export const MIN_HEIGHT = 120;
export const DEFAULT_HEIGHT = 240;
export const MAX_FRACTION = 0.7;
export const KEY_STEP = 16;

export const maxHeight = (column: number): number => Math.max(MIN_HEIGHT, Math.floor(column * MAX_FRACTION));
export const clampHeight = (height: number, column: number): number =>
  Math.min(maxHeight(column), Math.max(MIN_HEIGHT, Math.round(height)));

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice lasts the session */ }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === "true" ? true : value === "false" ? false : fallback;
  } catch { return fallback; }
}

function readHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
  } catch { return DEFAULT_HEIGHT; }
}

function readActiveTab(): BottomPanelTab {
  try { return localStorage.getItem(ACTIVE_TAB_KEY) === "output" ? "output" : "terminal"; }
  catch { return "terminal"; }
}

export function useBottomPanelState(mode: Mode) {
  const [open, setOpenState] = useState(() => readBoolean(OPEN_KEY, mode === "developer"));
  const [height, setHeight] = useState(readHeight);
  const [activeTab, setActiveTabState] = useState(readActiveTab);
  const [maximised, setMaximisedState] = useState(() => readBoolean(MAXIMISED_KEY, false));
  const setOpen = useCallback((value: boolean) => { setOpenState(value); write(OPEN_KEY, String(value)); }, []);
  const toggleOpen = useCallback(() => setOpenState(value => { write(OPEN_KEY, String(!value)); return !value; }), []);
  const commitHeight = useCallback((value: number) => { setHeight(value); write(HEIGHT_KEY, String(value)); }, []);
  const setActiveTab = useCallback((value: BottomPanelTab) => { setActiveTabState(value); write(ACTIVE_TAB_KEY, value); }, []);
  const toggleMaximised = useCallback(() => setMaximisedState(value => { write(MAXIMISED_KEY, String(!value)); return !value; }), []);
  return { open, setOpen, toggleOpen, height, setHeight, commitHeight, activeTab, setActiveTab, maximised, toggleMaximised };
}
