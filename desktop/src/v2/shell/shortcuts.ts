// Shortcut strings such as "Mod+Shift+P": matching a key event and spelling the chord for a person.
type Chord = { mod: boolean; ctrl: boolean; shift: boolean; alt: boolean; key: string };

function parse(shortcut: string): Chord {
  const parts = shortcut.split("+");
  const key = (parts.pop() ?? "").toLowerCase();
  const has = (name: string) => parts.includes(name);
  return { mod: has("Mod"), ctrl: has("Ctrl"), shift: has("Shift"), alt: has("Alt"), key };
}

function keyMatches(event: KeyboardEvent, key: string): boolean {
  if (key === "`") return event.code === "Backquote" || event.key === "`";
  return event.key.toLowerCase() === key;
}

/** Mod is Command or Control, as the search palette already treats it. */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const chord = parse(shortcut);
  if (event.altKey !== chord.alt || event.shiftKey !== chord.shift) return false;
  const modDown = event.metaKey || event.ctrlKey;
  if (chord.mod ? !modDown : event.metaKey || event.ctrlKey !== chord.ctrl) return false;
  return keyMatches(event, chord.key);
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const MAC_SYMBOL = new Map([["Mod", "⌘"], ["Ctrl", "⌃"], ["Shift", "⇧"], ["Alt", "⌥"]]);
const PC_NAME = new Map([["Mod", "Ctrl"]]);

export function formatShortcut(shortcut: string, mac: boolean = isMac()): string {
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  const shown = key.length === 1 ? key.toUpperCase() : key;
  if (mac) return [...parts.map(p => MAC_SYMBOL.get(p) ?? p), shown].join("");
  return [...parts.map(p => PC_NAME.get(p) ?? p), shown].join("+");
}

/** True when the event comes from inside a terminal, which keeps every key for itself. */
export function inTerminal(event: KeyboardEvent): boolean {
  return event.target instanceof Element && event.target.closest(".xterm") !== null;
}

/** Command chords reach the app from inside a terminal (#14268); Ctrl+key stays with the shell, and copy and paste stay with the terminal. */
export function appChordFromTerminal(event: KeyboardEvent): boolean {
  return event.metaKey && !event.ctrlKey && !["c", "v", "x", "a"].includes(event.key.toLowerCase());
}
