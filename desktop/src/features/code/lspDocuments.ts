// The document half of the language-server bridge (#5857). The editor's models live in VANILLA
// monaco (monacoSetup.ts — theme, workers, the muted TS service), which is a DIFFERENT registry
// than the monaco-vscode-api the language client's own sync features listen to, so a bare
// `monaco.editor.createModel` never produced a didOpen: the server sat with no open document and
// `std::` could never complete. This module syncs explicitly instead: track a model, and once a
// live client owns its crate, send didOpen with the current text, forward every edit as an
// incremental didChange, and didClose when the model dies. Completion rides the same client
// through CodeView's provider registration. Everything here is monaco-free (structural types
// only) so the mapping is unit-testable without booting the editor.

/** The slice of the language client the sync needs (MonacoLanguageClient satisfies it). */
export type DocClient = {
  sendNotification(method: string, params: unknown): Promise<unknown>;
  sendRequest(method: string, params: unknown): Promise<unknown>;
};

/** One live client as the picker sees it — plain data, so pickClient stays pure. */
export type DocClientRow = { workspaceRoot: string; language: string; client: DocClient };

/** The slice of a monaco ITextModel the sync needs (structural — tests use fakes). The URI is
 *  normalized with String() so both monaco's Uri objects and plain strings fit. */
export type SyncModel = {
  uri: { toString(): string };
  getValue(): string;
  getVersionId(): number;
  onDidChangeContent(cb: (e: { changes: ModelChange[] }) => void): { dispose(): void };
  onWillDispose(cb: () => void): void;
};

/** monaco's change shape (1-based positions); converted to LSP's 0-based on the way out. */
export type ModelChange = {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
};

// ── pure protocol shapes ──────────────────────────────────────────────────────────────────────

export function didOpenParams(uri: string, languageId: string, version: number, text: string) {
  return { textDocument: { uri, languageId, version, text } };
}

export function didChangeParams(uri: string, version: number, changes: ModelChange[]) {
  return {
    textDocument: { uri, version },
    contentChanges: changes.map(c => ({
      range: {
        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
      },
      text: c.text,
    })),
  };
}

export function didCloseParams(uri: string) {
  return { textDocument: { uri } };
}

/** LSP positions are 0-based; monaco's lineNumber/column are 1-based (UTF-16 columns, which is
 *  the positionEncoding both sides agreed on). */
export function completionParams(uri: string, lineNumber: number, column: number) {
  return { textDocument: { uri }, position: { line: lineNumber - 1, character: column - 1 } };
}

/** The crate a file URI sits under, or null for a non-file URI. */
function filePath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  return decodeURIComponent(uri.slice("file://".length));
}

/** Pick the client whose workspace root CONTAINS the document — the longest prefix wins, so a
 *  nested crate beats the checkout-wide server. No match (no client, or the file sits outside
 *  every served root) → null, and the document simply stays unsynced. */
export function pickClient(rows: DocClientRow[], uri: string, languageId: string): DocClient | null {
  const path = filePath(uri);
  if (!path) return null;
  let best: DocClient | null = null;
  let bestLen = -1;
  for (const row of rows) {
    if (row.language !== languageId) continue;
    const root = row.workspaceRoot;
    if (path !== root && !path.startsWith(root + "/")) continue;
    if (root.length > bestLen) {
      best = row.client;
      bestLen = root.length;
    }
  }
  return best;
}

// ── completion mapping ─────────────────────────────────────────────────────────────────────────

/** The monaco enums the mapping needs, injected so this module never imports monaco. CodeView
 *  passes `monaco.languages.CompletionItemKind` + `…CompletionItemInsertTextRule.InsertAsSnippet`. */
export type CompletionKinds = Record<string, number> & { insertAsSnippetRule: number };

/** LSP CompletionItemKind → monaco's CompletionItemKind, by name (the numeric spaces differ). */
const KIND_NAMES: Record<number, string> = {
  1: "Text", 2: "Method", 3: "Function", 4: "Constructor", 5: "Field", 6: "Variable",
  7: "Class", 8: "Interface", 9: "Module", 10: "Property", 11: "Unit", 12: "Value",
  13: "Enum", 14: "Keyword", 15: "Snippet", 16: "Color", 17: "File", 18: "Reference",
  19: "Folder", 20: "EnumMember", 21: "Constant", 22: "Struct", 23: "Event",
  24: "Operator", 25: "TypeParameter",
};

/** The range an LSP TextEdit points at, converted to monaco's 1-based shape. */
function toMonacoRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

type LspCompletionItem = {
  label?: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value?: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText?: string; range?: Parameters<typeof toMonacoRange>[0] };
};

/** One mapped suggestion, in monaco's CompletionItem shape (a plain literal is all it takes). */
export type Suggestion = {
  label: string;
  kind: number;
  insertText: string;
  range: ReturnType<typeof toMonacoRange>;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertTextRules?: number;
};

/** Map an LSP completion response (an array, or { items }) to monaco suggestions. `range` is the
 *  fallback for items without a textEdit — the word range at the cursor. */
export function toMonacoSuggestions(
  result: unknown,
  range: ReturnType<typeof toMonacoRange>,
  kinds: CompletionKinds,
): Suggestion[] {
  const items: LspCompletionItem[] = Array.isArray(result)
    ? result
    : ((result as { items?: LspCompletionItem[] } | null)?.items ?? []);
  const out: Suggestion[] = [];
  for (const item of items) {
    if (!item || typeof item.label !== "string") continue;
    const kindName = KIND_NAMES[item.kind ?? 1] ?? "Text";
    const suggestion: Suggestion = {
      label: item.label,
      kind: kinds[kindName] ?? kinds.Text,
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      range: item.textEdit?.range ? toMonacoRange(item.textEdit.range) : range,
    };
    if (item.detail) suggestion.detail = item.detail;
    const doc = typeof item.documentation === "string" ? item.documentation : item.documentation?.value;
    if (doc) suggestion.documentation = doc;
    suggestion.sortText = item.sortText ?? item.label;
    if (item.filterText) suggestion.filterText = item.filterText;
    if (item.insertTextFormat === 2) suggestion.insertTextRules = kinds.insertAsSnippetRule;
    out.push(suggestion);
  }
  return out;
}

// ── the sync registry ──────────────────────────────────────────────────────────────────────────

type Entry = {
  model: SyncModel;
  uri: string;
  languageId: string;
  /** The client this document is open against, or null while no client owns its crate. */
  client: DocClient | null;
  changeSub: { dispose(): void };
};

const tracked = new Map<string, Entry>();

/** Rows for the picker — set once by lspClient (which owns the client registry) so this module
 *  never imports it and no import cycle exists. */
let rowsSource: () => DocClientRow[] = () => [];
export function setDocClientRows(fn: () => DocClientRow[]): void {
  rowsSource = fn;
}

function send(client: DocClient, method: string, params: unknown): void {
  // Notifications are fire-and-forget; a dead server's rejection is already surfaced by the
  // reader's lsp-closed path, and an unhandled rejection here would be pure noise.
  void client.sendNotification(method, params).catch(() => {});
}

function attach(entry: Entry, client: DocClient): void {
  entry.client = client;
  send(entry.client, "textDocument/didOpen",
    didOpenParams(entry.uri, entry.languageId, entry.model.getVersionId(), entry.model.getValue()));
}

/** Track a model for LSP sync. Idempotent per URI: a second editor over the same model gets the
 *  existing entry, so didChange is never forwarded twice and didOpen never doubles. didClose
 *  rides the MODEL's disposal, not an editor's — a reused model stays open on the server. */
export function trackDocument(model: SyncModel, languageId: string): void {
  const uri = String(model.uri);
  if (tracked.has(uri)) return;
  const entry: Entry = {
    model,
    uri,
    languageId,
    client: null,
    changeSub: model.onDidChangeContent(e => {
      const cur = tracked.get(uri);
      if (!cur?.client) return;
      send(cur.client, "textDocument/didChange",
        didChangeParams(uri, model.getVersionId(), e.changes));
    }),
  };
  tracked.set(uri, entry);
  model.onWillDispose(() => {
    const cur = tracked.get(uri);
    if (!cur) return;
    if (cur.client) send(cur.client, "textDocument/didClose", didCloseParams(uri));
    cur.changeSub.dispose();
    tracked.delete(uri);
  });
  attachEntry(entry);
}

function attachEntry(entry: Entry): void {
  const client = pickClient(rowsSource(), entry.uri, entry.languageId);
  if (client && entry.client !== client) attach(entry, client);
  else if (!client) entry.client = null;
}

/** Re-point every tracked document at a live client: opens docs whose client just came up, drops
 *  the attachment of docs whose client went away (a respawn re-opens them on the fresh client).
 *  Called by lspClient's notify — every client start/stop lands here. */
export function attachOpenDocuments(): void {
  for (const entry of tracked.values()) attachEntry(entry);
}

/** Ask the owning client for completions at a 1-based position. No client → null (the provider
 *  returns an empty list, exactly the no-server silence the editor had). */
export async function lspCompletion(
  uri: string,
  languageId: string,
  lineNumber: number,
  column: number,
): Promise<unknown> {
  const client = pickClient(rowsSource(), uri, languageId);
  if (!client) return null;
  return client.sendRequest("textDocument/completion", completionParams(uri, lineNumber, column)).catch(() => null);
}
