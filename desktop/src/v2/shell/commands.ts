// The one command registry: screens register their commands while mounted, the command palette
// and the Keyboard settings page read it, and the shortcut layer runs a command by its chord.
import { useEffect, useRef, useSyncExternalStore } from "react";

export type Command = {
  id: string;
  title: string;
  group: string;
  /** For example "Mod+Shift+P". Mod is Command on a Mac and Control elsewhere. */
  shortcut?: string;
  /** The key is handled by its owner; the registry only lists it. */
  listOnly?: boolean;
  run: () => void;
  /** Absent means always available. */
  when?: () => boolean;
};

export const GROUP_ORDER = ["Go to", "Search", "Mode", "View", "Terminal", "Git", "Commands"];

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let snapshot: Command[] = [];

function publish() {
  snapshot = [...registry.values()];
  listeners.forEach(notify => notify());
}

/** Adds commands and returns the call that removes them. A later registration of an id replaces an earlier one. */
export function registerCommands(commands: Command[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  publish();
  return () => {
    for (const command of commands) if (registry.get(command.id) === command) registry.delete(command.id);
    publish();
  };
}

export const getCommands = (): Command[] => snapshot;

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function useCommands(): Command[] {
  return useSyncExternalStore(subscribe, getCommands);
}

/** Registers for as long as the caller is mounted; run and when always use the latest closures. */
export function useRegisterCommands(commands: Command[]): void {
  const latest = useRef(commands);
  latest.current = commands;
  const signature = commands.map(c => `${c.id}\u0000${c.title}\u0000${c.shortcut ?? ""}`).join("\u0001");
  useEffect(() => {
    const current = (id: string) => latest.current.find(c => c.id === id);
    return registerCommands(latest.current.map(c => ({
      ...c,
      run: () => current(c.id)?.run(),
      when: c.when ? () => current(c.id)?.when?.() ?? false : undefined,
    })));
  }, [signature]);
}

/** The commands a person can use right now. */
export const availableCommands = (all: Command[]): Command[] => all.filter(c => !c.when || c.when());

/** Subsequence match: null when a letter of the query is missing, higher when letters sit together or start a word. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    score += 1 + (at === previous + 1 ? 5 : 0) + (at === 0 || t[at - 1] === " " ? 3 : 0);
    previous = at;
    from = at + 1;
  }
  return score - t.length * 0.01;
}

/** Orders by group, then by registration; with a query, by match quality. */
export function filterCommands(all: Command[], query: string): Command[] {
  if (!query.trim()) {
    const rank = (c: Command) => { const i = GROUP_ORDER.indexOf(c.group); return i < 0 ? GROUP_ORDER.length : i; };
    return all.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(x => x.c);
  }
  return all
    .map(c => ({ c, score: fuzzyScore(query, c.title) ?? fuzzyScore(query, `${c.group} ${c.title}`) }))
    .filter((x): x is { c: Command; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map(x => x.c);
}
