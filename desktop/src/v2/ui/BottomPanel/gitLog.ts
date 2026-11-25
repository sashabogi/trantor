// #14268: an in-memory log of the git commands the Code screen ran, read by the Output tab's Git channel.
import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/** The argument shapes the Code screen sends its git commands. */
export type GitArgs = { [key: string]: string | number | boolean | string[] | null | undefined };

export type GitLogEntry = { id: number; at: number; command: string; ok: boolean; output: string };

const MAX_ENTRIES = 300;
const OUTPUT_LINES = 3;
// The panel poll runs every few seconds and would bury the commands a person ran; only its failures are logged.
const QUIET = new Set(["git_panel", "git_operation"]);
const HIDDEN_ARGS = new Set(["project", "agent", "scope", "patch"]);

let entries: GitLogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };

export function recordGit(command: string, ok: boolean, output: string, at = Date.now()) {
  entries = [...entries, { id: nextId++, at, command, ok, output }].slice(-MAX_ENTRIES);
  emit();
}

export function clearGitLog() { entries = []; emit(); }
export function gitLogEntries(): readonly GitLogEntry[] { return entries; }

export function useGitLog(): readonly GitLogEntry[] {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, gitLogEntries);
}

/** "git_branch_switch" with {name:"main"} reads "git branch switch main". */
export function commandLabel(name: string, args: GitArgs = {}): string {
  const rest = Object.entries(args)
    .filter(([key, value]) => !HIDDEN_ARGS.has(key) && value !== null && value !== undefined && value !== true && value !== false)
    .map(([, value]) => [value].flat().join(" "))
    .filter(Boolean).join(" ");
  const label = `${name.replace(/_/g, " ")}${rest ? ` ${rest}` : ""}`;
  return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}

/** The first lines of a command's output, enough to see what happened. */
export function firstLines(text: string, count = OUTPUT_LINES): string[] {
  return text.split("\n").map(l => l.trimEnd()).filter(Boolean).slice(0, count).map(l => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
}

/** Tauri's invoke for a git command, with the call, its time and its result pushed onto the log. */
export async function loggedInvoke<T>(name: string, args: GitArgs = {}): Promise<T> {
  try {
    const result = await invoke<T>(name, args);
    // JSON payloads are the data a screen reads, not output a person wants to see; plain text is.
    const text = result === null || result === undefined ? "" : String(result).trimStart();
    if (!QUIET.has(name)) recordGit(commandLabel(name, args), true, text.startsWith("{") || text.startsWith("[") ? "" : text);
    return result;
  } catch (reason) {
    recordGit(commandLabel(name, args), false, reason instanceof Error ? reason.message : String(reason));
    throw reason;
  }
}

export function formatGitEntry(entry: GitLogEntry): string[] {
  const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
  return [`${time}  ${entry.command}  ${entry.ok ? "ok" : "failed"}`, ...firstLines(entry.output).map(l => `    ${l}`)];
}
