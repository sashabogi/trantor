// #14204: a one-shot note that opens Settings on a named page, the way openIntent does for Code.
import type { SectionId } from "../screens/Settings/sections";

let pending: SectionId | null = null;
const watchers = new Set<() => void>();

export function openSettingsAt(id: SectionId): void {
  pending = id;
  watchers.forEach(wake => wake());
}

/** Returns the waiting page and clears it, so it fires once. */
export function takeSettingsSection(): SectionId | null {
  const id = pending;
  pending = null;
  return id;
}

/** Calls `wake` whenever a page is asked for; returns the call that stops it. */
export function watchSettingsSection(wake: () => void): () => void {
  watchers.add(wake);
  return () => { watchers.delete(wake); };
}
