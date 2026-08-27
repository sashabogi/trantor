// The project's files, one directory level at a time. Lazy on purpose: a repo the size of
// crm-platform costs only what the operator actually expands.
import { invoke } from "@tauri-apps/api/core";

export type FileEntry = {
  name: string;
  /** path relative to the project root — the key for asking for this folder's children */
  path: string;
  dir: boolean;
  /** git's porcelain code, trimmed. "" when unchanged. */
  status: string;
};

export async function projectFiles(project: string, sub?: string): Promise<FileEntry[]> {
  return JSON.parse(await invoke<string>("project_files", { project, sub: sub ?? null }));
}

/** What a porcelain code means to someone watching agents work. Untracked reads as "new" because
 *  that is what it is when an agent just wrote it. */
export function statusLabel(code: string): string {
  if (!code) return "";
  if (code === "??") return "new";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("A")) return "added";
  return "changed";
}

/** Colour tokens, not raw hex, so the tree tracks the palette like everything else. */
export function statusColor(code: string): string {
  if (!code) return "";
  if (code === "??" || code.startsWith("A")) return "var(--color-tr-ok)";
  if (code.startsWith("D")) return "var(--color-tr-danger)";
  return "var(--color-tr-doing)";
}
