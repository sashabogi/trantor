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
import "./monacoSetup";

// ── transport ────────────────────────────────────────────────────────────────────────────────

/** reader: `lsp-message:<id>` events → JSON-RPC messages. */
class TauriMessageReader extends AbstractMessageReader {
  constructor(private readonly id: number) {
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
      const msg: Message = JSON.parse(ev.payload);
      callback(msg);
    }).then(fn => { if (disposed) fn(); else unlistens.push(fn); }).catch(() => {});
    // The server closing stdout is the one honest "no longer ready" signal.
    listen(`lsp-closed:${this.id}`, () => {
      if (!disposed) this.fireClose();
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
const clients = new Map<ClientKey, { id: number; client: MonacoLanguageClient }>();

const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

/** Subscribe to client start/stop — the editor flips quickSuggestions on these edges. */
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

const keyFor = (project: string, scope: string | null, language: string) =>
  `${project}\u0000${scope ?? ""}\u0000${language}`;

/** Start (or return) the client for (project, scope, language). One per root+language, so tabs
 *  share it. Throws `not installed: <name>` when the server binary is missing. */
export async function startLsp(project: string, scope: string | null, language: string): Promise<number> {
  const key = keyFor(project, scope, language);
  const existing = clients.get(key);
  if (existing) return existing.id;

  await ensureServices();
  const id = await invoke<number>("lsp_start", { project, scope, language });
  const transports: MessageTransports = {
    reader: new TauriMessageReader(id),
    writer: new TauriMessageWriter(id),
  };
  const client = new MonacoLanguageClient({
    name: `lsp:${language}`,
    id: key,
    clientOptions: { documentSelector: [language] },
    messageTransports: transports,
  });
  await client.start();
  clients.set(key, { id, client });
  notify();
  return id;
}

/** Stop every client and its server — the Files unmount cleanup. */
export async function stopAllLsp(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, { id, client }] of entries) {
    await client.stop().catch(() => {});
    await invoke("lsp_stop", { id }).catch(() => {});
  }
  notify();
}
