// Revealing a folder in the Code Explorer (#14327): the Explorer keeps its open folders in local
// storage per project and checkout, so revealing one means opening it and every folder above it there.
import { expandedKey } from "../../ui/useExplorerData";

/** `a/b/c` as the folders to open: a, a/b, a/b/c. A path with nothing in it opens nothing. */
export function foldersToOpen(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function revealFolder(project: string, seat: string | null, path: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): void {
  const wanted = foldersToOpen(path);
  if (wanted.length === 0) return;
  const key = expandedKey(project, seat);
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    const open = Array.isArray(raw) ? raw.map(String) : [];
    storage.setItem(key, JSON.stringify([...new Set([...open, ...wanted])]));
  } catch { /* storage blocked: the Explorer still opens, just without the folder */ }
}
