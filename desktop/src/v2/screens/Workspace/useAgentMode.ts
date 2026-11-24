// The hosted agent's live permission mode, read off its pane and switched by the native closed loop (#14022).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Choice } from "../../ui/Composer2";

type ModeRead = { mode: string; prompt_showing: boolean };
type ModeSwitch = { mode: string; seen: string[] };

/** Claude Code's modes. Another harness plugs in its own catalog and always-offered set (#14018). */
export const CLAUDE_MODES: readonly Choice[] = [
  { value: "default", label: "Agent", short: "Agent", icon: "hand", description: "Asks before edits and commands." },
  { value: "acceptEdits", label: "Agent, accept edits", short: "Accept edits", icon: "pencil", description: "Edits files without asking; still asks before commands." },
  { value: "plan", label: "Plan", short: "Plan", icon: "plan", description: "Reads and plans; changes nothing until you approve the plan." },
  { value: "auto", label: "Auto", short: "Auto", icon: "sparkles", description: "Claude Code decides what is safe to run; most actions go without a prompt." },
  { value: "bypassPermissions", label: "Bypass permissions", short: "Bypass", icon: "zap", tone: "warn", description: "Nothing asks: every edit and command runs." },
];
export const CLAUDE_ALWAYS: readonly string[] = ["default", "acceptEdits", "plan"];

/** The rows to offer: the always-there modes plus any this session's cycle has actually shown. */
export function modeChoicesFor(catalog: readonly Choice[], always: readonly string[], seen: ReadonlySet<string>): Choice[] {
  return catalog.filter(c => always.includes(c.value) || seen.has(c.value));
}

// A refusal that means "this pane has no Claude Code modes", as opposed to a read that failed this once.
const NOT_HERE = /not a Claude Code pane|not supported for remote panes/;

export type AgentMode = {
  /** False: no section at all. */
  supported: boolean;
  /** What was READ; null when the parser could not tell. */
  mode: string | null;
  choices: Choice[];
  set: (value: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
  read: () => void;
};

export function useAgentMode(target: string | null, working: boolean): AgentMode {
  const [supported, setSupported] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const live = useRef(target);
  live.current = target;
  const note = (modes: readonly string[]) => setSeen(s => modes.every(m => s.has(m)) ? s : new Set([...s, ...modes]));
  const read = useCallback(() => {
    if (!target) { setSupported(false); setMode(null); return; }
    invoke<ModeRead | null>("pane_mode_get", { target }).then(r => {
      if (live.current !== target) return;
      // A reply without a mode is a desktop that does not speak this command: no section, never a guess.
      if (!r?.mode) { setSupported(false); setMode(null); return; }
      setSupported(true);
      setMode(r.mode === "unknown" ? null : r.mode);
      if (r.mode !== "unknown") note([r.mode]);
    }, e => {
      if (live.current !== target) return;
      if (NOT_HERE.test(String(e))) setSupported(false);
      setMode(null);
    });
  }, [target]);
  useEffect(() => { setSeen(new Set()); setError(null); read(); }, [read]);
  useEffect(() => { if (!working) read(); }, [working, read]);
  useEffect(() => {
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  const set = (value: string) => {
    if (!target) return Promise.resolve();
    setError(null);
    return invoke<ModeSwitch | null>("pane_mode_set", { target, mode: value }).then(r => {
      if (!r?.mode) { read(); return; }
      setMode(r.mode);
      note(r.seen ?? []);
    }, e => {
      setError(`Mode not changed: ${String(e)}`);
      read();
    });
  };
  return {
    supported, mode, error, read, set, clearError: () => setError(null),
    choices: modeChoicesFor(CLAUDE_MODES, CLAUDE_ALWAYS, seen),
  };
}
