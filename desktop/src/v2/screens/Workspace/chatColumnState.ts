// Width and open state of the Workspace side columns (chat on the right, files on the left), persisted per user (#13987 drill).
import { useCallback, useState } from "react";
import { readMode } from "../../shell/shellMode";

export const WIDTH_KEY = "trantor.v2.workspace.chatWidth";
export const OPEN_KEY = "trantor.v2.workspace.chatOpen";
export const MIN_WIDTH = 320;
export const DEFAULT_WIDTH = 400;
export const RAIL_WIDTH = 44;
export const KEY_STEP = 16;
export const MAX_FRACTION = 0.6;

export const FILES_WIDTH_KEY = "trantor.v2.workspace.filesWidth";
export const FILES_OPEN_KEY = "trantor.v2.workspace.filesOpen";
export const FILES_MIN_WIDTH = 180;
export const FILES_DEFAULT_WIDTH = 260;
export const FILES_RAIL_WIDTH = 40;
export const FILES_MAX_FRACTION = 0.4;

/** What one side column persists and how far it may stretch. */
export type ColumnConfig = {
  widthKey: string; openKey: string; min: number; fallbackWidth: number; maxFraction: number;
  /** Open state when nothing was stored. */
  defaultOpen: () => boolean;
};

/** The widest a column may be: its fraction of the workspace, never below its minimum. */
export const maxFor = (cfg: ColumnConfig, workspace: number): number => Math.max(cfg.min, Math.floor(workspace * cfg.maxFraction));
export const clampFor = (cfg: ColumnConfig, w: number, workspace: number): number =>
  Math.min(maxFor(cfg, workspace), Math.max(cfg.min, Math.round(w)));

export const CHAT_COLUMN: ColumnConfig = {
  widthKey: WIDTH_KEY, openKey: OPEN_KEY, min: MIN_WIDTH, fallbackWidth: DEFAULT_WIDTH, maxFraction: MAX_FRACTION, defaultOpen: () => true,
};
// #13987 drill: Orchestrator mode keeps files out of the way (a rail); Developer mode opens them. A stored choice wins.
export const FILES_COLUMN: ColumnConfig = {
  widthKey: FILES_WIDTH_KEY, openKey: FILES_OPEN_KEY, min: FILES_MIN_WIDTH, fallbackWidth: FILES_DEFAULT_WIDTH, maxFraction: FILES_MAX_FRACTION,
  defaultOpen: () => readMode() === "developer",
};

export const maxWidthFor = (workspace: number): number => maxFor(CHAT_COLUMN, workspace);
export const clampWidth = (w: number, workspace: number): number => clampFor(CHAT_COLUMN, w, workspace);

function readWidth(cfg: ColumnConfig): number {
  try {
    const n = Number(localStorage.getItem(cfg.widthKey));
    return Number.isFinite(n) && n >= cfg.min ? n : cfg.fallbackWidth;
  } catch { return cfg.fallbackWidth; }
}

function readOpen(cfg: ColumnConfig): boolean {
  try {
    const v = localStorage.getItem(cfg.openKey);
    return v === "true" ? true : v === "false" ? false : cfg.defaultOpen();
  } catch { return cfg.defaultOpen(); }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice lasts the session */ }
}

export function useColumn(cfg: ColumnConfig) {
  const [width, setWidthState] = useState(() => readWidth(cfg));
  const [open, setOpenState] = useState(() => readOpen(cfg));
  const setWidth = useCallback((w: number) => setWidthState(w), []);
  const commitWidth = useCallback((w: number) => { setWidthState(w); write(cfg.widthKey, String(w)); }, [cfg]);
  const setOpen = useCallback((o: boolean) => { setOpenState(o); write(cfg.openKey, String(o)); }, [cfg]);
  return { width, setWidth, commitWidth, open, setOpen };
}

export const useChatColumn = () => useColumn(CHAT_COLUMN);
export const useFilesColumn = () => useColumn(FILES_COLUMN);
