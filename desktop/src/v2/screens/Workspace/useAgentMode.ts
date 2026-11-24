// The hosted agent's live permission mode, read off its pane and switched by the native closed loop (#14022).
// #14030: the table gates it — below the Mode menu's verified range the section shows one disabled
// row and never presses a key; above it the closed-loop read stays the guard, with an honest note
// when the mode line cannot be read on a newer Claude Code.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Choice } from "../../ui/Composer2";
import type { FeatureRange } from "../../shell/agentCli";

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
  /** #14030: set when a NEWER-than-verified Claude Code's mode line could not be read — the
   * explanation replaces a bare "Mode unknown" in the status line. */
  unverifiedNote: string | null;
};

// #14030: the gate's own row — current by construction, so a click only closes the menu and no
// key is ever pressed while the version is below the feature's verified range.
function gatedChoice(range: FeatureRange): Choice {
  return {
    value: "needs-update",
    short: "Mode unknown",
    label: `Mode switching needs Claude Code ${range.verifiedFrom ?? "a newer version"} or newer`,
    description: `you have ${range.installed ?? "an unreadable version"}`,
    tone: "warn",
  };
}

export function useAgentMode(target: string | null, working: boolean, range?: FeatureRange | null): AgentMode {
  const [supported, setSupported] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const gated = range?.verdict === "below";
  const live = useRef(target);
  live.current = target;
  const note = (modes: readonly string[]) => setSeen(s => modes.every(m => s.has(m)) ? s : new Set([...s, ...modes]));
  const read = useCallback(() => {
    if (gated) return; // #14030: below the verified range the section's answer is the row itself.
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
  }, [target, gated]);
  useEffect(() => { setSeen(new Set()); setError(null); read(); }, [read]);
  useEffect(() => { if (!working) read(); }, [working, read]);
  useEffect(() => {
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  const set = (value: string) => {
    if (gated) return Promise.resolve(); // #14030: never press a key below the verified range.
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
  // #14030: above the verified range the read stays the guard — an unknown mode is explained,
  // never silently "Mode unknown". In range and unknown data: no change.
  const unverifiedNote = range?.verdict === "above" && supported && mode === null
    ? `Claude Code ${range.installed ?? ""} is newer than the version mode switching was checked on (${range.verifiedTo ?? "?"}), and its mode line could not be read.`
    : null;
  return {
    supported: gated ? true : supported,
    mode: gated ? "needs-update" : mode,
    error, read, set, clearError: () => setError(null),
    choices: gated ? [gatedChoice(range)] : modeChoicesFor(CLAUDE_MODES, CLAUDE_ALWAYS, seen),
    unverifiedNote,
  };
}
