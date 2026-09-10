// The Files column's open/closed state, persisted to localStorage as a working preference. The
// store is passed in, so the toggle/persist logic stays pure and testable under node.
export interface FilesColumnStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "trantor.files.open";

/** Whether the Files column starts open. Defaults OPEN: the tree is the reason the row exists. */
export function filesColumnOpen(store: FilesColumnStore): boolean {
  try { return store.getItem(KEY) !== "0"; } catch { return true; }
}

/** Persist the column's open/closed state; a privacy-mode failure just means it is not remembered. */
export function persistFilesColumn(store: FilesColumnStore, open: boolean): void {
  try { store.setItem(KEY, open ? "1" : "0"); } catch { /* private mode */ }
}
