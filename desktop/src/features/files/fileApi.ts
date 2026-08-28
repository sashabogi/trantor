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

/** `seat` picks WHICH copy: undefined = the project checkout, otherwise that seat's worktree.
 *  The two genuinely differ — a seat's worktree carries work the checkout has never seen — so the
 *  caller always says which one it means. */
export async function projectFiles(project: string, sub?: string, seat?: string): Promise<FileEntry[]> {
  return JSON.parse(await invoke<string>("project_files", { project, sub: sub ?? null, seat: seat ?? null }));
}

export type FileBody = { text: string; truncated: boolean; bytes: number };

export async function readFile(project: string, path: string, seat?: string): Promise<FileBody> {
  return JSON.parse(await invoke<string>("read_file", { project, path, seat: seat ?? null }));
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

/** This file's diff against HEAD, or an all-new diff when git has never seen it. Empty string
 *  means unchanged. */
export async function fileDiff(project: string, path: string, seat?: string): Promise<string> {
  return invoke<string>("file_diff", { project, path, seat: seat ?? null });
}

/** Whether a seat is writing to its worktree right now. ONE owner for this answer: herdr, which
 *  the runner updates at every turn boundary. Deriving it a second way from bus status is how the
 *  UI and the writer end up disagreeing about whether an edit is safe. */
export async function seatState(agent: string): Promise<string> {
  return invoke<string>("seat_state", { agent });
}

/** Save an edit. Returns the commit sha, or "" when the text was unchanged.
 *
 *  Saving commits, authored to you. `trantor integrate` commits a seat's dirty worktree AS THAT
 *  SEAT, so an uncommitted tweak of yours would be attributed to the agent the next time it ran. */
export async function writeFile(project: string, path: string, seat: string | undefined, text: string): Promise<string> {
  return invoke<string>("write_file", { project, path, seat: seat ?? null, text });
}

/** This file as HEAD has it, or "" when git has never seen it (the whole file is new).
 *  A real side-by-side diff needs the two DOCUMENTS; a unified patch is a description of the
 *  change, and rendering that as text is not something you can read code in. */
export async function readFileAtHead(project: string, path: string, seat?: string): Promise<string> {
  return invoke<string>("read_file_at_head", { project, path, seat: seat ?? null });
}

/** Paths matching a query, for the composer's @-reference menu. Bounded in Rust on depth and
 *  count, because this runs on every keystroke. */
export async function searchFiles(project: string, query: string, seat?: string): Promise<string[]> {
  return JSON.parse(await invoke<string>("search_files", { project, query, seat: seat ?? null }));
}
