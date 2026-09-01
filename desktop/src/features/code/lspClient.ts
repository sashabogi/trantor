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
type ProgressProbe = { method?: string; params?: { value?: { kind?: string } } };

/** rust-analyzer reports its initial indexing as `$/progress` notifications; the first
 *  `kind: "end"` is the moment "ready" stops being a lie. */
function isProgressEnd(msg: ProgressProbe): boolean {
  return msg.method === "$/progress" && msg.params?.value?.kind === "end";
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
      if (this.onProgressEnd && isProgressEnd(raw)) this.onProgressEnd();
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
type ClientEntry = { id: number; root: string; client: MonacoLanguageClient };
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

/** Whether a live client for `language` has NOT yet sent its first `$/progress` end — the
 *  "indexing…" half of the status line. */
export function isLspIndexing(language: string): boolean {
  for (const key of clients.keys()) {
    if (key.endsWith(`\u0000${language}`) && !indexed.has(key)) return true;
  }
  return false;
}

const keyFor = (project: string, scope: string | null, language: string) =>
  `${project}\u0000${scope ?? ""}\u0000${language}`;

/** The resolved scope root plus the id the editor keys later calls by. */
export type LspStartResult = { id: number; root: string; indexing: boolean };

/** Start (or return) the client for (project, scope, language). One per root+language, so tabs
 *  share it. Throws `not installed: <name>` when the server binary is missing. */
export async function startLsp(
  project: string,
  scope: string | null,
  language: string,
): Promise<LspStartResult> {
  const key = keyFor(project, scope, language);
  const existing = clients.get(key);
  if (existing) return { id: existing.id, root: existing.root, indexing: !indexed.has(key) };

  await ensureServices();
  const started = await invoke<{ id: number; root: string }>("lsp_start", { project, scope, language });
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
      // rootUri must be the crate root, not null, or rust-analyzer loads no project — the same
      // root lsp_start chose (and returned), never recomputed here.
      workspaceFolder: { uri: vscode.Uri.file(started.root), name: project, index: 0 },
    },
    messageTransports: transports,
  });
  await client.start();
  clients.set(key, { id: started.id, root: started.root, client });
  notify();
  return { id: started.id, root: started.root, indexing: !indexed.has(key) };
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
