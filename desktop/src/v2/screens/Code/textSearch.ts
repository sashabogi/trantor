// Project text search (#14074): the native `search_text` command, typed.
import { invoke } from "@tauri-apps/api/core";

export type TextMatch = { line: number; column: number; text: string };
export type FileMatches = { path: string; matches: TextMatch[] };
export type TextSearchResult = { files: FileMatches[]; total: number; truncated: boolean };

export async function searchText(project: string, query: string, seat: string | undefined, caseSensitive: boolean): Promise<TextSearchResult> {
  const raw = await invoke<string>("search_text", { project, query, seat: seat ?? null, caseSensitive });
  // SAFETY: the Rust command serialises exactly this shape (text_search.rs TextSearchResult).
  return JSON.parse(raw) as TextSearchResult;
}
