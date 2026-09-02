// The language-server bridge. Rust owns the servers and frames their JSON-RPC (src-tauri/src/
// lsp.rs); this module keeps ONE client per (root, language) shared across tabs, on the Tauri
// transport from lspTransport.ts. monacoSetup.ts's TS mute stays as the no-client fallback: when
// a client is live for a language, the server owns diagnostics and suggestions, and the editor
// turns its own quickSuggestions on. Documents are synced explicitly by lspDocuments.ts (#5857):
// the editor's models are VANILLA monaco, a different registry than the monaco-vscode-api the
// client's own sync listens to, so didOpen/didChange/completion ride this module's rows.
import { MonacoLanguageClient } from "monaco-languageclient";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { MessageTransports } from "vscode-languageclient/browser.js";
import { invoke } from "@tauri-apps/api/core";
import * as vscode from "vscode";
import { isReadyToken } from "./lspProtocol";
import { decideLspStart } from "./lspStart";
import { TauriMessageReader, TauriMessageWriter, trace } from "./lspTransport";
import { attachOpenDocuments, setDocClientRows, type DocClientRow } from "./lspDocuments";
import "./monacoSetup";

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
type ClientEntry = { id: number; scopeRoot: string; workspaceRoot: string; client: MonacoLanguageClient };
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
const notify = () => {
  for (const fn of listeners) fn();
  // The document sync re-points open models at live clients on every start/stop (#5857).
  attachOpenDocuments();
};

/** Rejects after 30s so a hung client.start() cannot pin pendingStarts forever (#5857). Stops
 *  the server first: its handshake state is unrecoverable once the client gave up, and the
 *  respawn rule in lspStart.ts only fires for an initialized:true report. */
function lspStartTimeout(key: ClientKey, id: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      trace(`startLsp ${key} client start TIMED OUT after 30s — stopping server id=${id}`);
      invoke("lsp_stop", { id }).catch(() => {});
      reject(new Error(`lsp start timed out after 30s (${key})`));
    }, 30_000);
  });
}

/** Live clients as plain rows for the document sync (lspDocuments.ts picks by crate prefix). */
export function lspClientRows(): DocClientRow[] {
  const rows: DocClientRow[] = [];
  for (const [key, entry] of clients) {
    rows.push({ workspaceRoot: entry.workspaceRoot, language: key.slice(key.indexOf("\u0000") + 1), client: entry.client });
  }
  return rows;
}
setDocClientRows(lspClientRows);

/** Subscribe to client start/stop/indexing/phase — the editor flips quickSuggestions on these. */
export function onLspChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether a client is currently live for a language. With a workspaceRoot, keyed EXACTLY by
 *  (workspaceRoot, language) (#12752): the project server's "ready" must not answer for the
 *  seat-worktree server of the same language, which is a different process still loading. */
export function isLspLive(language: string, workspaceRoot?: string): boolean {
  for (const key of clients.keys()) {
    if (keyMatches(key, language, workspaceRoot)) return true;
  }
  return false;
}

/** The current analysis phase title (e.g. "cachePriming"), or null once ready. Scoped exactly
 *  like isLspLive when a workspaceRoot is given. */
export function lspPhase(language: string, workspaceRoot?: string): string | null {
  for (const [key, phase] of phases) {
    if (keyMatches(key, language, workspaceRoot)) return phase;
  }
  return null;
}

/** Whether a live client for the scoped key has NOT yet sent its ready `$/progress` end. Only
 *  rust has the long load phase; other servers are "ready" once the handshake returns. */
export function isLspIndexing(language: string, workspaceRoot?: string): boolean {
  if (language !== "rust") return false;
  for (const key of clients.keys()) {
    if (keyMatches(key, language, workspaceRoot) && !indexed.has(key)) return true;
  }
  return false;
}

function keyMatches(key: ClientKey, language: string, workspaceRoot?: string): boolean {
  return workspaceRoot ? key === `${workspaceRoot}\u0000${language}` : key.endsWith(`\u0000${language}`);
}

/** The resolved scope root (for the model URI), the crate root the client keys by, plus the id
 *  the editor keys later calls by. */
export type LspStartResult = { id: number; scopeRoot: string; workspaceRoot: string; indexing: boolean };

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
  if (existing) {
    trace(`startLsp ${key} reuse id=${existing.id} (client already registered)`);
    return { id: existing.id, scopeRoot: existing.scopeRoot, workspaceRoot: started.workspaceRoot, indexing: isLspIndexing(language, started.workspaceRoot) };
  }

  // A start already in flight for this key IS the client about to exist (#5857 bounce) — await
  // it instead of building a second one against the same live server.
  const pending = pendingStarts.get(key);
  if (pending) {
    trace(`startLsp ${key} awaiting an in-flight start`);
    return pending;
  }

  trace(`startLsp ${key} id=${started.id} wsRoot=${started.workspaceRoot} initialized=${started.initialized}`);
  const attempt = (async () => {
    await ensureServices();
    // The reuse rule (#5857 bounce, lspStart.ts): a live server already through its handshake
    // must never see a second `initialize` — respawn a fresh process instead.
    const decision = decideLspStart(started, clients.has(key));
    if (decision.action === "respawn") {
      trace(`startLsp ${key} respawn: initialized server had no client — stopping ${decision.stopId}`);
      await invoke("lsp_stop", { id: decision.stopId }).catch(() => {});
      indexed.delete(key);
      phases.delete(key);
      started = await invoke<{ id: number; scopeRoot: string; workspaceRoot: string; initialized: boolean }>(
        "lsp_start",
        { project, scope, language, path },
      );
      trace(`startLsp ${key} respawned as id=${started.id}`);
    }
    const reader = new TauriMessageReader(started.id, e => {
      if (e.kind === "begin" && e.title) {
        phases.set(key, e.title);
        trace(`lsp ${key} phase begin: ${e.title}`);
        notify();
      } else if (e.kind === "end" && isReadyToken(e.token)) {
        if (!indexed.has(key)) {
          indexed.add(key);
          trace(`lsp ${key} ready`);
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
    try {
      // Tauri drops an event with no subscriber: if `initialize` goes out before the reader's
      // subscriptions are confirmed registered, Rust's 7ms reply is lost and start() hangs
      // forever (rust-1.trace: handshake, then silence — #5857). Gate the first write on it.
      await reader.ready;
      // A hung start must not pin pendingStarts forever: a remount then awaits a promise that
      // never settles (app-trace.log: "awaiting an in-flight start" 44s after the first start).
      // On timeout, stop the server so the retry respawns a fresh process, and reject so the
      // remount can retry.
      await Promise.race([client.start(), lspStartTimeout(key, started.id)]);
    } catch (e) {
      // A start that fails AFTER the wire handshake must say so — the 0.3.111 silence (initialize
      // answered, then nothing, #5857) had no line here, so a hung/failed start was invisible.
      trace(`startLsp ${key} client start FAILED: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    trace(`startLsp ${key} client running`);
    clients.set(key, { id: started.id, scopeRoot: started.scopeRoot, workspaceRoot: started.workspaceRoot, client });
    notify();
    return {
      id: started.id,
      scopeRoot: started.scopeRoot,
      workspaceRoot: started.workspaceRoot,
      indexing: isLspIndexing(language, started.workspaceRoot),
    };
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
