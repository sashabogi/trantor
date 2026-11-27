// The live browser state for one project: one read on mount, then every change arrives as a
// browser://state event — the tab renders from events and never polls (#14489 contract, #14505).
// B1's Rust commands land in parallel, so every call tolerates a missing backend and leaves the
// empty state standing.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_ASK_EVENT, BROWSER_STATE_EVENT, EMPTY_BROWSER_STATE,
  type BrowserArgs, type BrowserAsk, type BrowserAskChoice, type BrowserRect, type BrowserState, type BrowserStep,
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
};

/** What the tab renders from: the live state, the open ask, whether the mount read settled, the commands. */
export type BrowserView = { state: BrowserState; ask: BrowserAsk | null; read: boolean; steps: BrowserStep[]; commands: BrowserCommands };

// Rust sends "" for "no page"; the tab's empty state keys on null.
const normalize = (s: BrowserState): BrowserState => (s.url ? s : { ...s, url: null });

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
  }), [send]);

  return { state, ask, read, steps, commands };
}
