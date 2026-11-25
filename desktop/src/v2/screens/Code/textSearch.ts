// Project text search (#14074): the native `search_text` command, typed. #14104 adds the option
// set (regular expression, whole word, include/exclude globs) and the `replace_text` command.
import { invoke } from "@tauri-apps/api/core";

export type TextMatch = { line: number; column: number; text: string; markLen?: number | null };
export type FileMatches = { path: string; matches: TextMatch[]; mtimeMs: number; bytes: number };
export type TextSearchResult = { files: FileMatches[]; total: number; truncated: boolean };

/** The options the search box shows; `include`/`exclude` are comma-separated globs. */
export type SearchOptions = {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  include?: string | null;
  exclude?: string | null;
};

export async function searchText(project: string, query: string, seat: string | undefined, opts: SearchOptions): Promise<TextSearchResult> {
  const raw = await invoke<string>("search_text", {
    project, query, seat: seat ?? null,
    caseSensitive: opts.caseSensitive, regex: opts.regex, wholeWord: opts.wholeWord,
    include: opts.include ?? null, exclude: opts.exclude ?? null,
  });
  // SAFETY: the Rust command serialises exactly this shape (text_search.rs TextSearchResult).
  return JSON.parse(raw) as TextSearchResult;
}

/** The one result a "replace this result" click targets, in the search's own units. */
export type ReplaceAt = { line: number; column: number };
export type ReplaceResult = { replaced: number };
export type ReplaceOptions = { caseSensitive: boolean; regex: boolean; wholeWord: boolean };

/** Replace in ONE file. `expect` is the file's stat from the search: the command refuses a file
 *  that changed since the search ran, so a stale replace never writes over fresh work. */
export async function replaceText(
  project: string,
  path: string,
  query: string,
  replacement: string,
  seat: string | undefined,
  opts: ReplaceOptions,
  expect: { mtimeMs: number; bytes: number },
  only?: ReplaceAt,
): Promise<ReplaceResult> {
  const raw = await invoke<string>("replace_text", {
    project, path, query, replacement, seat: seat ?? null,
    caseSensitive: opts.caseSensitive, regex: opts.regex, wholeWord: opts.wholeWord,
    only: only ?? null, mtimeMs: expect.mtimeMs, bytes: expect.bytes,
  });
  // SAFETY: the Rust command serialises exactly this shape (text_search.rs ReplaceOutcome).
  return JSON.parse(raw) as ReplaceResult;
}
