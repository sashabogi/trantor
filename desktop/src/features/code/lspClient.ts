// The language-server bridge. Rust owns the servers and frames their JSON-RPC (src-tauri/src/
// lsp.rs); this module keeps ONE client per (root, language) shared across tabs, on the Tauri
// transport from lspTransport.ts. monacoSetup.ts's TS mute stays as the no-client fallback: when
// a client is live for a language, the server owns diagnostics and suggestions, and the editor
// turns its own quickSuggestions on. Documents are synced explicitly by lspDocuments.ts (#5857):
// the editor's models are VANILLA monaco, a different registry than the monaco-vscode-api the
// client's own sync listens to, so didOpen/didChange/completion ride this module's rows.
//
// The monaco/vscode/tauri boundaries are INJECTED through `setLspClientDeps` (the same service-
// seam pattern setDocClientRows uses) so lspClient.test.ts drives startLsp over a faithful
// in-memory bus instead of module-mocking @tauri or monaco. Production never calls the setter:
// the DEFAULT deps lazy-load the real browser runtime (lspRuntime.ts, which imports monaco) only
// when a client actually starts — so this file imports cleanly in a node test that never boots
// monaco.
import type { MessageTransports } from "vscode-languageclient/browser.js";
import { isReadyToken } from "./lspProtocol";
import { decideLspStart } from "./lspStart";
import { TauriMessageReader, TauriMessageWriter, trace, traceKey, type LspBus } from "./lspTransport";
import { attachOpenDocuments, setDocClientRows, type DocClientRow, type DocNotifyParams, type CompletionRequest, type LspCompletionResponse } from "./lspDocuments";

// ── injected seams ─────────────────────────────────────────────────────────────────────────────

/** The started-server report lsp_start resolves to. */
export type LspStarted = { id: number; scopeRoot: string; workspaceRoot: string; initialized: boolean };

/** The slice of a monaco language client this module drives (start/stop + the doc sync's wire
 *  methods). MonacoLanguageClient satisfies it structurally; tests supply a faithful fake. */
export type LspClientLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendNotification(method: string, params: DocNotifyParams): Promise<void>;
  sendRequest(method: string, params: CompletionRequest): Promise<LspCompletionResponse>;
};

/** Every external thing startLsp reaches. The default deps load the real browser runtime lazily;
 *  tests replace them with an in-memory bus + fake monaco through setLspClientDeps. */
export type LspClientDeps = {
  startServer(args: { project: string; scope: string | null; language: string; path: string }): Promise<LspStarted>;
  stopServer(id: number): Promise<void>;
  stopProjectServer(project: string): Promise<void>;
  /** The transport's wire bus (lsp_send + subscriptions); omit to use the transport's real tauri
   *  bus — a test that injects monaco fakes but no bus still drives a REAL wire. */
  bus?: LspBus;
  /** vscode.Uri.file — a { toString() } uri is all the clientOptions need. */
  fileUri(path: string): { toString(): string };
  /** Start the monaco-vscode-api once (ensureServices). */
  ensureServices(): Promise<void>;
  /** Build the language client over the message transports. */
  makeClient(opts: { name: string; id: string; workspaceRoot: string; project: string; transports: MessageTransports }): LspClientLike;
  /** How long a client.start() may take before the server is stopped and start rejects. The
   *  DEFAULT is 30s (real hub); a test shrinks it so a hung start is exercised in milliseconds. */
  startTimeoutMs?: number;
};

let injectedDeps: LspClientDeps | null = null;
let realDepsPromise: Promise<LspClientDeps> | null = null;

/** Test seam only — production keeps the lazy real runtime. Same pattern as setDocClientRows. */
export function setLspClientDeps(next: LspClientDeps | null): void {
  injectedDeps = next;
  realDepsPromise = null;
}

async function loadDeps(): Promise<LspClientDeps> {
  if (injectedDeps) return injectedDeps;
  if (!realDepsPromise) realDepsPromise = import("./lspRuntime").then((m) => m.realLspDeps());
  return realDepsPromise;
}

// ── services + client registry ───────────────────────────────────────────────────────────────

/** The monaco-vscode-api must start once, ever. Lazy so an editor with no served file never pays. */
let servicesPromise: Promise<void> | null = null;

function ensureServices(): Promise<void> {
  if (!servicesPromise) servicesPromise = loadDeps().then((d) => d.ensureServices());
  return servicesPromise;
}

type ClientKey = string;
type ClientEntry = { id: number; scopeRoot: string; workspaceRoot: string; client: LspClientLike };
const clients = new Map<ClientKey, ClientEntry>();
// Starts already in flight, by key (#5857 bounce): a remount that races a pending client.start()
// used to build a SECOND client for the same live server and re-initialize it — the map only
// fills AFTER start() resolves, so "no client yet" said nothing about a start being underway.
// Each entry carries its project so a project switch can drop exactly that project's pendings.
const pendingStarts = new Map<ClientKey, { project: string; promise: Promise<LspStartResult> }>();
// Per-project switch epochs (#6311): stopLspProject bumps the switched-away project's epoch, so
// a start that was mid-flight for it refuses to register — its server is stopped (or about to
// be) by lsp_stop_project, and registering would cache a zombie client that answers isLspLive()
// while every completion rejects. Switching back then reused that zombie: completions dead.
const switchEpochs = new Map<string, number>();
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

/** The armed start cap: `promise` rejects after `ms` of wire silence unless `cancel()` disarms
 *  it; every inbound frame calls `arm()` to restart the silence window. */
type LspStartCap = { promise: Promise<never>; arm(): void; cancel(): void };

/** The start cap (#6311): a timer that fires only after `ms` of WIRE SILENCE. Every inbound
 *  frame re-arms it (the reader's onFrame hook), so a server that answered initialize — or is
 *  streaming progress while the client waits out a long workspace load — is NEVER stopped by the
 *  cap. `cancel()` disarms it for good once client.start() has settled. The 0.3.134 timer could
 *  not be cancelled: it fired at +30s even when start() had won the race, tracing "TIMED OUT"
 *  and stopping the server while didOpen and publishDiagnostics were already flowing
 *  (app-trace.log id=2) — every project switch's fresh server died 30s after start. */
function lspStartTimeout(
  key: ClientKey,
  id: number,
  stopServer: (id: number) => Promise<void>,
  ms: number,
): LspStartCap {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<never>((_, reject) => { rejectFn = reject; });
  const fire = () => {
    if (settled) return;
    settled = true;
    trace(`startLsp ${traceKey(key)} client start TIMED OUT after ${ms}ms of wire silence — stopping server id=${id}`);
    void stopServer(id).catch(() => {});
    rejectFn(new Error(`lsp start timed out after ${ms}ms of wire silence (${key})`));
  };
  return {
    promise,
    arm: () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, ms);
    },
    cancel: () => {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
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
  const d = await loadDeps();
  let started = await d.startServer({ project, scope, language, path });
  const key = `${started.workspaceRoot}\u0000${language}`;
  const existing = clients.get(key);
  if (existing) {
    trace(`startLsp ${traceKey(key)} reuse id=${existing.id} (client already registered)`);
    return { id: existing.id, scopeRoot: existing.scopeRoot, workspaceRoot: started.workspaceRoot, indexing: isLspIndexing(language, started.workspaceRoot) };
  }

  // A start already in flight for this key IS the client about to exist (#5857 bounce) — await
  // it instead of building a second one against the same live server.
  const pending = pendingStarts.get(key);
  if (pending) {
    trace(`startLsp ${traceKey(key)} awaiting an in-flight start`);
    return pending.promise;
  }

  // The switch epoch this attempt belongs to: if stopLspProject(project) runs while the attempt
  // is in flight, the epoch mismatch below abandons it before it can register.
  const epoch = switchEpochs.get(project) ?? 0;

  // One line saying which (#6311): a project switch ALWAYS detaches, so a start for a project
  // whose epoch moved is a deterministic RESTART (or respawn), never a silent re-target.
  const switchLine = (switchEpochs.get(project) ?? 0) > 0 ? " (restart after project switch)" : "";
  trace(`startLsp ${traceKey(key)} id=${started.id} wsRoot=${started.workspaceRoot} initialized=${started.initialized}${switchLine}`);
  const attempt = (async () => {
    await ensureServices();
    // The reuse rule (#5857 bounce, lspStart.ts): a live server already through its handshake
    // must never see a second `initialize` — respawn a fresh process instead.
    const decision = decideLspStart(started, clients.has(key));
    if (decision.action === "respawn") {
      trace(`startLsp ${traceKey(key)} respawn: initialized server had no client — stopping ${decision.stopId}`);
      await d.stopServer(decision.stopId).catch(() => {});
      indexed.delete(key);
      phases.delete(key);
      started = await d.startServer({ project, scope, language, path });
      trace(`startLsp ${traceKey(key)} respawned as id=${started.id}`);
    }
    const cap = lspStartTimeout(key, started.id, (id) => d.stopServer(id), d.startTimeoutMs ?? 30_000);
    const reader = new TauriMessageReader(started.id, (e) => {
      if (e.kind === "begin" && e.title) {
        phases.set(key, e.title);
        trace(`lsp ${traceKey(key)} phase begin: ${e.title}`);
        notify();
      } else if (e.kind === "end" && isReadyToken(e.token)) {
        if (!indexed.has(key)) {
          indexed.add(key);
          trace(`lsp ${traceKey(key)} ready`);
          notify();
        }
        phases.delete(key);
      }
    }, d.bus, cap.arm);
    const transports: MessageTransports = {
      reader,
      writer: new TauriMessageWriter(started.id, d.bus),
    };
    const client = d.makeClient({
      name: `lsp:${language}`,
      id: key,
      workspaceRoot: started.workspaceRoot,
      project,
      transports,
    });
    // The subscription is an IPC of its own; the first write must not race it (#5857, 0.3.113).
    await reader.ready;
    const startT0 = Date.now();
    cap.arm();
    const startPromise = client.start();
    // A losing client.start() (the timeout won the race below) must still be observed — otherwise
    // its eventual rejection is an unhandled promise rejection. The race keeps the original promise.
    startPromise.catch(() => {});
    try {
      // A hung start must not pin pendingStarts forever: a remount then awaits a promise that
      // never settles (app-trace.log: "awaiting an in-flight start" 44s after the first start).
      // On timeout, stop the server so the retry respawns a fresh process, and reject so the
      // remount can retry. The cap only fires on WIRE SILENCE — every inbound frame re-arms it.
      await Promise.race([startPromise, cap.promise]);
    } catch (e) {
      // A start that fails AFTER the wire handshake must say so — the 0.3.111 silence (initialize
      // answered, then nothing, #5857) had no line here, so a hung/failed start was invisible.
      trace(`startLsp ${traceKey(key)} client start FAILED: ${e instanceof Error ? e.message : String(e)}`);
      // The abandoned client (timeout won the race, or start() itself failed) must be torn down —
      // otherwise the reader's two Tauri subscriptions (lsp-message:<id>, lsp-closed:<id>, taken in
      // TauriMessageReader's constructor) outlive it and leak.
      await client.stop().catch(() => {});
      reader.dispose();
      throw e;
    }
    // The start settled: the cap is cancelled for good. THIS is the #6311 fix — the old timer had
    // no cancel, so it fired at +30s on this now-healthy server and stopped it mid-session.
    cap.cancel();
    // A start that was mid-flight when its project switched away must not register: its server
    // was stopped by the switch, and a registered client on a dead id would answer isLspLive()
    // while every completion rejects — the zombie a switch-back then reused (#6311).
    if ((switchEpochs.get(project) ?? 0) !== epoch) {
      trace(`startLsp ${traceKey(key)} start abandoned: project switched away mid-start`);
      await client.stop().catch(() => {});
      reader.dispose();
      throw new Error(`lsp start superseded by a project switch (${key})`);
    }
    trace(`startLsp ${traceKey(key)} client running — start settled in ${Date.now() - startT0}ms, start cap cancelled`);
    clients.set(key, { id: started.id, scopeRoot: started.scopeRoot, workspaceRoot: started.workspaceRoot, client });
    notify();
    return {
      id: started.id,
      scopeRoot: started.scopeRoot,
      workspaceRoot: started.workspaceRoot,
      indexing: isLspIndexing(language, started.workspaceRoot),
    };
  })();
  pendingStarts.set(key, { project, promise: attempt });
  try {
    return await attempt;
  } finally {
    pendingStarts.delete(key);
  }
}

/** Stop every server for a project — the editor calls this on project switch. */
export async function stopLspProject(project: string): Promise<void> {
  const d = await loadDeps();
  await detachLspClients();
  await d.stopProjectServer(project).catch(() => {});
  // The switch is authoritative (#6311): bump the epoch so an in-flight start for THIS project
  // abandons itself instead of registering against the server the switch just stopped, and drop
  // its pending entry so the next startLsp for the same key builds a fresh attempt.
  switchEpochs.set(project, (switchEpochs.get(project) ?? 0) + 1);
  for (const [k, pending] of pendingStarts) {
    if (pending.project === project) pendingStarts.delete(k);
  }
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
