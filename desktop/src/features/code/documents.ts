// The editor's document store (#5938): the state that must OUTLIVE the lens, held at module
// level and keyed by project. AppShell unmounts the Code surface on every lens switch, and until
// this store existed the operator's tabs, drafts, and dirty flags died with it. Files becomes a
// VIEW over this store — it reads on mount, writes on every change, and does nothing on unmount.
//
// Composition, not duplication: tab-list operations still go through the PURE helpers in
// codeTabs.ts (openInTabs/pin/close/markDirty/markExternalMutation), and the disk-conflict
// decision stays in tabGuard.ts. This file only OWNS the maps — tabs, activeKey, and per-tab
// { draft, disk, baseSignature, loaded } — exactly the refs Files used to hold (draftsRef,
// diskRef, sigRef, loadedKeyRef) plus the tabs state.
import type { CodeTab } from "./codeTabs";

export type DocumentState = {
  /** The live editor content — unsaved work lives here. */
  draft: string;
  /** The disk text the document was last loaded from / saved as. */
  disk: string;
  /** Orca's lastKnownDiskSignature (open-file.ts:126): the fingerprint of `disk`, for the
   *  tabGuard decision when the file is re-read. */
  baseSignature: string;
  /** Has this tab's document ever finished loading on screen? A draft may only be stashed for a
   *  loaded document — a draft without a completed load is a loading screen, not work. */
  loaded: boolean;
};

export type ProjectDocuments = {
  tabs: CodeTab[];
  activeKey: string | null;
  docs: Map<string, DocumentState>;
};

const store = new Map<string, ProjectDocuments>();

export function projectDocuments(project: string): ProjectDocuments {
  let docs = store.get(project);
  if (!docs) {
    docs = { tabs: [], activeKey: null, docs: new Map() };
    store.set(project, docs);
  }
  return docs;
}

function documentOf(project: string, key: string): DocumentState {
  const docs = projectDocuments(project);
  let d = docs.docs.get(key);
  if (!d) {
    d = { draft: "", disk: "", baseSignature: "", loaded: false };
    docs.docs.set(key, d);
  }
  return d;
}

/** Replace the tab list wholesale — composed from the pure codeTabs helpers by the caller. */
export function setTabs(project: string, tabs: CodeTab[]): void {
  projectDocuments(project).tabs = tabs;
}

export function setActiveKey(project: string, key: string | null): void {
  projectDocuments(project).activeKey = key;
}

export function setDraft(project: string, key: string, draft: string): void {
  documentOf(project, key).draft = draft;
}

export function setDisk(project: string, key: string, disk: string): void {
  documentOf(project, key).disk = disk;
}

export function setBaseSignature(project: string, key: string, signature: string): void {
  documentOf(project, key).baseSignature = signature;
}

export function markLoaded(project: string, key: string): void {
  documentOf(project, key).loaded = true;
}

export function clearLoaded(project: string, key: string): void {
  documentOf(project, key).loaded = false;
}

/** Closing a tab drops its document — the one deliberate destruction (the tab is the work's
 *  address; with the tab gone the draft has no door). */
export function dropDocument(project: string, key: string): void {
  projectDocuments(project).docs.delete(key);
}

/** The resumed draft for a file, by its scope+path — what an editor must create its model FROM,
 *  so a remount never builds a model from a lagging empty prop (#5857 bounce). Null when this
 *  tab has never been opened. */
export function storedDraft(project: string, seat: string | null | undefined, path: string): string | null {
  const key = `${seat ?? "project"}:${path}`;
  const draft = projectDocuments(project).docs.get(key)?.draft;
  return draft === undefined ? null : draft;
}

/** The draft a tab may RESUME from: only a document that finished loading has one. A fresh entry
 *  is created by the first touch (setDisk, markLoaded) with draft "", and returning that "" as
 *  a kept draft is how the editor opened lib.rs empty with a false conflict bar (0.3.105). */
export function keptDraft(project: string, key: string): { draft: string; baseSignature: string } | undefined {
  const d = projectDocuments(project).docs.get(key);
  if (!d || !d.loaded) return undefined;
  return { draft: d.draft, baseSignature: d.baseSignature };
}

/** Whether a lens may write its local draft back to the store as the tab's kept work (#5938).
 *  Three things must be true: there is an active document, it finished loading (a draft without a
 *  completed load is a loading screen), and the VIEW has hydrated its local draft from that very
 *  document. The third leg is the 2026-09-02 empty-editor regression: on remount the effect that
 *  opens the tree-selected path ran before the effect that hydrates the local draft, so the stash
 *  wrote the initial "" over a 222,668-character kept draft, and reload then let "" win. */
export function canStashDraft(args: { activeKey: string | null; loaded: boolean; hydratedKey: string | null }): boolean {
  return !!args.activeKey && args.loaded && args.hydratedKey === args.activeKey;
}
