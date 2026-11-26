// #14344: one git_panel read per (project, scope), shared by every subscriber and polled once every 6 s,
// so the sidebar, the Explorer's status and the main-branch label stop polling the same status three times.
import { PROJECT_FOLDERS_CHANGED } from "../../projectsFolder";
import { scopePanel } from "./scopeGitApi";
import type { ScopeSnapshot, ScopeState } from "./useScopeGit";

export const SCOPE_POLL_MS = 6_000;

type Listener = (state: ScopeState) => void;
type Entry = {
  project: string;
  scope: string | null;
  state: ScopeState;
  listeners: Set<Listener>;
  latest: number;
  stop: () => void;
};

const entries = new Map<string, Entry>();
const keyOf = (project: string, scope: string | null) => `${project}\u0000${scope ?? ""}`;

async function readSnapshot(project: string, scope: string | null): Promise<ScopeSnapshot> {
  const p = await scopePanel(project, scope);
  return { scope, branch: p.branch || null, upstream: p.upstream, remote: p.remote, ahead: p.ahead, behind: p.behind,
    status: p.status, counts: p.counts, log: p.log, seatBacked: scope !== null, readAt: Date.now() };
}

function publish(entry: Entry, state: ScopeState) {
  entry.state = state;
  for (const listener of entry.listeners) listener(state);
}

function read(entry: Entry) {
  const mine = ++entry.latest;
  readSnapshot(entry.project, entry.scope)
    .then(snap => { if (mine === entry.latest && entries.has(keyOf(entry.project, entry.scope))) publish(entry, { kind: "ok", snap }); })
    .catch(e => { if (mine === entry.latest && entries.has(keyOf(entry.project, entry.scope))) publish(entry, { kind: "error", reason: e instanceof Error ? e.message : String(e) }); });
}

function open(project: string, scope: string | null): Entry {
  const entry: Entry = { project, scope, state: { kind: "loading" }, listeners: new Set(), latest: 0, stop: () => undefined };
  const refresh = () => read(entry);
  const timer = setInterval(refresh, SCOPE_POLL_MS);
  window.addEventListener(PROJECT_FOLDERS_CHANGED, refresh);
  entry.stop = () => { clearInterval(timer); window.removeEventListener(PROJECT_FOLDERS_CHANGED, refresh); };
  entries.set(keyOf(project, scope), entry);
  read(entry);
  return entry;
}

export type ScopeGitSubscription = { refresh: () => void; unsubscribe: () => void };

/** Joins the shared read for this scope: the current state arrives at once, later ones as they land. */
export function subscribeScopeGit(project: string, scope: string | null, listener: Listener): ScopeGitSubscription {
  const entry = entries.get(keyOf(project, scope)) ?? open(project, scope);
  entry.listeners.add(listener);
  if (entry.state.kind !== "loading") listener(entry.state);
  return {
    refresh: () => read(entry),
    unsubscribe: () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) { entry.stop(); entries.delete(keyOf(project, scope)); }
    },
  };
}

/** Re-reads a scope now, for a writer that is not itself a subscriber; a scope nobody watches has nothing to refresh. */
export function refreshScopeGit(project: string, scope: string | null): void {
  const entry = entries.get(keyOf(project, scope));
  if (entry) read(entry);
}
