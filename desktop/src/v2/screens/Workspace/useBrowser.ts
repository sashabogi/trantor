// The live browser state for one project: one read on mount, then every change arrives as a
// browser://state event — the tab renders from events and never polls (#14489 contract, #14505).
// B1/B5's Rust commands land in parallel, so every call tolerates a missing backend and leaves the
// empty state standing (#14516).
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_ASK_EVENT, BROWSER_STATE_EVENT, EMPTY_BROWSER_STATE,
  type BrowserArgs, type BrowserAsk, type BrowserAskChoice, type BrowserDevice, type BrowserFavorite,
  type BrowserHistoryEntry, type BrowserPermission, type BrowserRect, type BrowserState, type BrowserStep,
} from "./browserModel";

export type BrowserCommands = {
  open: (rect: BrowserRect) => void;
  setRect: (rect: BrowserRect) => void;
  setVisible: (visible: boolean) => void;
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  takeOver: () => void;
  giveBack: () => void;
  popOut: () => void;
  answer: (id: string, choice: BrowserAskChoice) => void;
  // Wave 2, pages (#14516).
  newPage: (url: string | null) => void;
  closePage: (page: string) => void;
  selectPage: (page: string) => void;
  // Wave 2, B5 controls.
  zoom: (level: number | null) => void;
  setUserAgent: (preset: string | null) => void;
  emulate: (device: BrowserDevice | null) => void;
  findClear: () => void;
  permissionRevoke: (host: string) => void;
  clearStorage: () => void;
  /** Runs the Inspector; resolves to its error's words, or null when it opened. */
  inspect: () => Promise<string | null>;
  /** Steps through matches; resolves to whether one was found, or null when the backend is away. */
  find: (text: string, backwards: boolean) => Promise<boolean | null>;
  /** Toggles the page in favorites; resolves to whether it is one now, or null when away. */
  favoriteToggle: (url: string, title: string) => Promise<boolean | null>;
};

/** The panel's reads: each returns null when the backend is away, never throws. */
export type BrowserLoad = {
  history: () => Promise<BrowserHistoryEntry[] | null>;
  favorites: () => Promise<BrowserFavorite[] | null>;
  permissions: () => Promise<BrowserPermission[] | null>;
};

/** What the tab renders from: the live state, the open ask, whether the mount read settled, the commands. */
export type BrowserView = {
  state: BrowserState;
  ask: BrowserAsk | null;
  read: boolean;
  steps: BrowserStep[];
  commands: BrowserCommands;
  load: BrowserLoad;
};

// Rust sends "" for "no page" (and a blank page may report about:blank); the empty state keys on null.
// A wave-1 core sends no pages/zoom/user_agent/emulation, so the defaults stand in for them.
const normalize = (s: BrowserState): BrowserState => ({
  ...s,
  url: s.url && s.url !== "about:blank" ? s.url : null,
  pages: Array.isArray(s.pages) ? s.pages : [],
  active_page: s.active_page ?? "",
  zoom: s.zoom ?? 1,
  user_agent: s.user_agent ?? "Safari",
  emulation: s.emulation ?? null,
});

export function useBrowser(project: string): BrowserView {
  const [state, setState] = useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [ask, setAsk] = useState<BrowserAsk | null>(null);
  const [steps, setSteps] = useState<BrowserStep[]>([]);
  // Settles once the mount read answered, either way: until then the tab holds off placing the page,
  // so it never opens or positions a browser that turns out to be popped out.
  const [read, setRead] = useState(false);

  useEffect(() => {
    let alive = true;
    const subs = [
      listen<BrowserState>(BROWSER_STATE_EVENT, e => {
        if (e.payload.project !== project) return;
        setState(normalize(e.payload));
        void invoke<BrowserStep[]>("browser_steps", { project }).then(s => { if (alive && Array.isArray(s)) setSteps(s); }).catch(() => {});
      }),
      listen<BrowserAsk>(BROWSER_ASK_EVENT, e => { if (e.payload.project === project) setAsk(e.payload); }),
    ];
    invoke<BrowserState>("browser_state", { project })
      .then(known => { if (alive) { setRead(true); if (known) setState(normalize(known)); } })
      .catch(() => { if (alive) setRead(true); });
    return () => {
      alive = false;
      for (const off of subs) void off.then(stop => stop()).catch(() => {});
    };
  }, [project]);

  const send = useCallback((command: string, args: BrowserArgs) => {
    void invoke(command, { project, ...args }).catch(() => {});
  }, [project]);

  // A command whose answer the tab shows: null on any failure, the value otherwise.
  const call = useCallback(<T,>(command: string, args: BrowserArgs): Promise<T | null> =>
    invoke<T>(command, { project, ...args }).catch(() => null), [project]);

  const commands = useMemo<BrowserCommands>(() => ({
    open: rect => send("browser_open", { url: null, rect }),
    setRect: rect => send("browser_set_rect", { rect }),
    setVisible: visible => send("browser_set_visible", { visible }),
    navigate: url => send("browser_navigate", { url }),
    back: () => send("browser_back", {}),
    forward: () => send("browser_forward", {}),
    reload: () => send("browser_reload", {}),
    takeOver: () => send("browser_take_over", {}),
    giveBack: () => send("browser_give_back", {}),
    popOut: () => send("browser_pop_out", {}),
    answer: (id, choice) => { setAsk(null); send("browser_answer", { id, choice }); },
    newPage: url => send("browser_new_page", { url }),
    closePage: page => send("browser_close_page", { page }),
    selectPage: page => send("browser_select_page", { page }),
    zoom: level => send("browser_zoom", { level }),
    setUserAgent: preset => send("browser_set_user_agent", { preset }),
    emulate: device => send("browser_emulate", { device }),
    findClear: () => send("browser_find_clear", {}),
    permissionRevoke: host => send("browser_permission_revoke", { host }),
    clearStorage: () => send("browser_clear_storage", {}),
    // The Inspector's failure is the one command error the operator must see in words.
    inspect: () => invoke<null>("browser_inspect", { project })
      .then((): string | null => null)
      .catch((e): string => (e instanceof Error ? e.message : String(e))),
    find: (text, backwards) => call<{ found: boolean }>("browser_find", { text, backwards }).then(r => r?.found ?? null),
    favoriteToggle: (url, title) => call<boolean>("browser_favorite_toggle", { url, title }),
  }), [send, call]);

  const load = useMemo<BrowserLoad>(() => ({
    history: () => call<BrowserHistoryEntry[]>("browser_history", {}),
    favorites: () => call<BrowserFavorite[]>("browser_favorites", {}),
    permissions: () => call<BrowserPermission[]>("browser_permissions", {}),
  }), [call]);

  return { state, ask, read, steps, commands, load };
}
