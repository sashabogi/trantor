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
import { isReadyToken, progressEvent, type ProgressEvent } from "./lspProtocol";
import { decideLspStart } from "./lspStart";
import "./monacoSetup";

// ── transport ────────────────────────────────────────────────────────────────────────────────

/** reader: `lsp-message:<id>` events → JSON-RPC messages. */
class TauriMessageReader extends AbstractMessageReader {
  constructor(
    private readonly id: number,
    private readonly onProgress?: (e: ProgressEvent) => void,
  ) {
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
      // A non-JSON payload must not throw and swallow the message — the initialize response rides
      // this path, and a dropped response leaves client.start() hanging forever. The connection
      // reports its own error if the bytes are not valid JSON-RPC.
      let raw: any;
      try {
        raw = JSON.parse(ev.payload);
      } catch {
        return;
      }
      if (this.onProgress) {
        const e = progressEvent(raw);
        if (e) this.onProgress(e);
      }
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
// Starts already in flight, by key (#5857 bounce): a remount that races a pending client.start()
// used to build a SECOND client for the same live server and re-initialize it — the map only
// fills AFTER start() resolves, so "no client yet" said nothing about a start being underway.
const pendingStarts = new Map<ClientKey, Promise<LspStartResult>>();
// Both survive a lens unmount: the Rust server outlives the lens, so its indexed/phase state does
// too — a remount re-attaches to the same server and reads the same "ready".
const indexed = new Set<ClientKey>();
const phases = new Map<ClientKey, string>();

const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

/** Subscribe to client start/stop/indexing/phase — the editor flips quickSuggestions on these. */
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

/** The current analysis phase title (e.g. "cachePriming"), or null once ready. */
export function lspPhase(language: string): string | null {
  for (const [key, phase] of phases) {
    if (key.endsWith(`\u0000${language}`)) return phase;
  }
  return null;
}

/** Whether a live client for `language` has NOT yet sent its ready `$/progress` end. Only rust
 *  has the long load phase; other servers are "ready" once the handshake returns. */
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
  let started = await invoke<{ id: number; scopeRoot: string; workspaceRoot: string; initialized: boolean }>(
    "lsp_start",
    { project, scope, language, path },
  );
  const key = `${started.workspaceRoot}\u0000${language}`;
  const existing = clients.get(key);
  if (existing) return { id: existing.id, scopeRoot: existing.scopeRoot, indexing: isLspIndexing(language) };

  // A start already in flight for this key IS the client about to exist (#5857 bounce) — await
  // it instead of building a second one against the same live server.
  const pending = pendingStarts.get(key);
  if (pending) return pending;

  const attempt = (async () => {
    await ensureServices();
    // The reuse rule (#5857 bounce, lspStart.ts): a live server already through its handshake
    // must never see a second `initialize` — respawn a fresh process instead.
    const decision = decideLspStart(started, clients.has(key));
    if (decision.action === "respawn") {
      await invoke("lsp_stop", { id: decision.stopId }).catch(() => {});
      indexed.delete(key);
      phases.delete(key);
      started = await invoke<{ id: number; scopeRoot: string; workspaceRoot: string; initialized: boolean }>(
        "lsp_start",
        { project, scope, language, path },
      );
    }
    const reader = new TauriMessageReader(started.id, e => {
      if (e.kind === "begin" && e.title) {
        phases.set(key, e.title);
        notify();
      } else if (e.kind === "end" && isReadyToken(e.token)) {
        if (!indexed.has(key)) {
          indexed.add(key);
          notify();
        }
        phases.delete(key);
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
  })();
  pendingStarts.set(key, attempt);
  try {
    return await attempt;
  } finally {
    pendingStarts.delete(key);
  }
}

/** Stop every server for a project — the editor calls this on project switch. */
export async function stopLspProject(project: string): Promise<void> {
  await detachLspClients();
  await invoke("lsp_stop_project", { project }).catch(() => {});
  indexed.clear();
  phases.clear();
  notify();
}

// A lens unmount detaches NOTHING: the MonacoLanguageClient stays in this module map, so a remount
// re-attaches to the same live client and server. Monaco fires didClose for the disposed model on
// its own; the client keeps running. (The 0.3.103 bug was client.stop() sending shutdown/exit and
// killing the server on every lens flip.)

/** Stop the clients for a project switch. `client.stop()` here is a REAL teardown — the Rust
 *  server is stopped right after via `lsp_stop_project`, so nothing re-attaches to a dead id. */
async function detachLspClients(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, { client }] of entries) {
    await client.stop().catch(() => {});
  }
  notify();
}
