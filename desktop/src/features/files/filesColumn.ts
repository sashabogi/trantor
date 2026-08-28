// The Files column's open/closed state, as a working preference.
//
// Whether you want the file tree visible is a choice that outlives one launch, so it persists to
// localStorage — but the I/O boundary stays here, not in the shell. Passing the store in (rather
// than reading the global) keeps the toggle/persist logic pure and testable under node.
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
