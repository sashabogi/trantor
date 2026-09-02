// The language-server bridge. Rust owns the servers and frames their JSON-RPC (src-tauri/src/
// lsp.rs); this module adapts that byte channel into the MessageTransports monaco-languageclient
// speaks, and keeps ONE client per (root, language) shared across tabs. monacoSetup.ts's TS mute
// stays as the no-client fallback: when a client is live for a language, the server owns
// diagnostics and suggestions, and the editor turns its own quickSuggestions on.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageWriter,
} from "vscode-jsonrpc";
import { MonacoLanguageClient } from "monaco-languageclient";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { MessageTransports } from "vscode-languageclient/browser.js";
import * as vscode from "vscode";
import "./monacoSetup";

// ── transport ────────────────────────────────────────────────────────────────────────────────

/** The `$/progress` notification shape, narrowed to what we read. */
type ProgressProbe = { method?: string; params?: { token?: string | number; value?: { kind?: string } } };

/** rust-analyzer reports its initial indexing as `$/progress` with a token like
 *  "rustAnalyzer/Indexing"; that token's `end` is the honest "ready". The quicker "loading" pass
 *  also sends `$/progress`, so match the indexing token, never just any end. */
function isIndexingEnd(msg: ProgressProbe): boolean {
  if (msg.method !== "$/progress") return false;
  const params = msg.params;
  if (!params || params.value?.kind !== "end") return false;
  const token = params.token == null ? "" : String(params.token);
  return /index/i.test(token);
}

/** reader: `lsp-message:<id>` events → JSON-RPC messages. */
class TauriMessageReader extends AbstractMessageReader {
  constructor(private readonly id: number, private readonly onProgressEnd?: () => void) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    let disposed = false;
    const unlistens: UnlistenFn[] = [];
    const stop = () => {
      disposed = true;
      for (const fn of unlistens) fn();
      unlistens.length = 0;
    };
    listen<string>(`lsp-message:${this.id}`, ev => {
      if (disposed) return;
      const raw = JSON.parse(ev.payload);
      if (this.onProgressEnd && isIndexingEnd(raw)) this.onProgressEnd();
      const msg: Message = raw;
      callback(msg);
    }).then(fn => { if (disposed) fn(); else unlistens.push(fn); }).catch(() => {});
    // The server closing stdout is the one honest "no longer ready" signal; the payload is the
    // server's own first stderr line ("error: Unknown binary …") when it exited early, so the
    // status line can name it instead of a bare "Unknown reason".
    listen<string | null>(`lsp-closed:${this.id}`, ev => {
      if (disposed) return;
      const reason = ev.payload;
      if (reason) this.fireError(new Error(reason));
      this.fireClose();
    }).then(fn => { if (disposed) fn(); else unlistens.push(fn); }).catch(() => {});
    return { dispose: stop };
  }
}

/** writer: JSON-RPC messages → `lsp_send`. */
class TauriMessageWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly id: number) {
    super();
  }

  async write(msg: Message): Promise<void> {
    // A Tauri rejection is a plain string; vscode-jsonrpc reads `.message` off it and shows
    // "Unknown reason" when there is none (0.3.96, seen on screen). Wrap so the real cause rides.
    try {
      await invoke("lsp_send", { id: this.id, message: JSON.stringify(msg) });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  end(): void {
    // The connection ends when the lens stops the server; nothing to flush on the wire.
  }
}

// ── services + client registry ───────────────────────────────────────────────────────────────

/** The monaco-vscode-api must start once, ever. Lazy so an editor with no served file never pays. */
let servicesPromise: Promise<void> | null = null;

function ensureServices(): Promise<void> {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const apiWrapper = new MonacoVscodeApiWrapper({
        $type: "classic",
        viewsConfig: { $type: "EditorService" },
      });
      await apiWrapper.start();
    })();
  }
  return servicesPromise;
}

type ClientKey = string;
type ClientEntry = { id: number; scopeRoot: string; client: MonacoLanguageClient };
const clients = new Map<ClientKey, ClientEntry>();
const indexed = new Set<ClientKey>();

const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

/** Subscribe to client start/stop/indexing — the editor flips quickSuggestions on these edges. */
export function onLspChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether a client is currently live for a language (any root). */
export function isLspLive(language: string): boolean {
  for (const key of clients.keys()) {
    if (key.endsWith(`\u0000${language}`)) return true;
  }
  return false;
}

/** Whether a live client for `language` has NOT yet sent its indexing `$/progress` end — the
 *  "indexing…" half of the status line. Only rust has that phase; other servers are "ready" once
 *  the handshake returns. */
export function isLspIndexing(language: string): boolean {
  if (language !== "rust") return false;
  for (const key of clients.keys()) {
    if (key.endsWith(`\u0000rust`) && !indexed.has(key)) return true;
  }
  return false;
}

/** The resolved scope root (for the model URI) plus the id the editor keys later calls by. */
export type LspStartResult = { id: number; scopeRoot: string; indexing: boolean };

/** Start (or return) the client for (project, scope, language, path). One per (workspace root,
 *  language) — rust-analyzer keys its project on the crate, so two crates in one checkout get two
 *  servers. Throws `not installed: <name>` when the server binary is missing. */
export async function startLsp(
  project: string,
  scope: string | null,
  language: string,
  path: string,
): Promise<LspStartResult> {
  const started = await invoke<{ id: number; scopeRoot: string; workspaceRoot: string }>(
    "lsp_start",
    { project, scope, language, path },
  );
  const key = `${started.workspaceRoot}\u0000${language}`;
  const existing = clients.get(key);
  if (existing) return { id: existing.id, scopeRoot: existing.scopeRoot, indexing: isLspIndexing(language) };

  await ensureServices();
  const reader = new TauriMessageReader(started.id, () => {
    if (!indexed.has(key)) {
      indexed.add(key);
      notify();
    }
  });
  const transports: MessageTransports = {
    reader,
    writer: new TauriMessageWriter(started.id),
  };
  const client = new MonacoLanguageClient({
    name: `lsp:${language}`,
    id: key,
    clientOptions: {
      documentSelector: [language],
      // rootUri must be the CRATE root (the nearest manifest), not the scope root or null, or
      // rust-analyzer loads no project — lsp_start resolved it, never recomputed here.
      workspaceFolder: { uri: vscode.Uri.file(started.workspaceRoot), name: project, index: 0 },
    },
    messageTransports: transports,
  });
  await client.start();
  clients.set(key, { id: started.id, scopeRoot: started.scopeRoot, client });
  notify();
  return { id: started.id, scopeRoot: started.scopeRoot, indexing: isLspIndexing(language) };
}

/** Stop every client and its server — the Files unmount cleanup. */
export async function stopAllLsp(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  indexed.clear();
  for (const [, { id, client }] of entries) {
    await client.stop().catch(() => {});
    await invoke("lsp_stop", { id }).catch(() => {});
  }
  notify();
}
