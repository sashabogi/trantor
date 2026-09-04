// startLsp's side of the #5857 handshake race: the client's first write (initialize) must not
// reach `lsp_send` before the reader's Tauri subscriptions are confirmed registered — Tauri
// drops an event with no subscriber, so a reply Rust emits in that window is lost and the start
// hangs forever (rust-1.trace: initialize out, result in 7ms, then silence). lspClient reaches
// tauri/monaco ONLY through its injected deps (setLspClientDeps — the same seam setDocClientRows
// uses), so the test drives the real startLsp over a faithful in-memory bus and fake client:
// no module mocking, and no monaco import (which cannot load under node).
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestMessage } from "vscode-jsonrpc";
import { setLspClientDeps, startLsp, stopLspProject, lspClientRows, onLspChange, isLspLive, type LspClientDeps, type LspClientLike } from "./lspClient";
import type { LspBus } from "./lspTransport";
type Handler = (ev: { payload: string | null }) => void;

function makeDeps() {
  const handlers = new Map<string, Handler[]>();
  const written: Array<{ method?: string; id?: number | string }> = [];
  const stopped: number[] = [];
  const unsubscribed: string[] = [];
  let clientStopCount = 0;
  let gate: Promise<void> | null = null;
  let wsRoot = "/proj/crate";
  let hangStart = false;
  const bus: LspBus = {
    async invoke<T>(cmd: "lsp_send", args: { id: number; message: string }): Promise<T> {
      if (cmd === "lsp_send" && args?.message) {
        // SAFETY: the writer serializes jsonrpc Message envelopes; parsing yields method/id-bearing
        // records — the wire format asserted below, never an arbitrary shape.
        written.push(JSON.parse(args.message) as { method?: string; id?: number | string });
      }
      // SAFETY: the bus contract types invoke<T>; the fake resolves to undefined for every command
      // the writer sends — asserting the generic return is the seam's own contract, nothing more.
      return undefined as T;
    },
    async listen<T extends string | null>(event: `lsp-message:${number}` | `lsp-closed:${number}`, handler: (ev: { payload: T }) => void) {
      // SAFETY: the transport subscribes with payload types string (messages) and string|null
      // (closed); the map stores handlers under that container and fires them with it.
      handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]);
      if (gate) await gate;
      // Records the event unsubscribing, mirroring the real Tauri unlisten fn — lets the timeout
      // test assert the reader's two subscriptions actually tore down, not just that stop() ran.
      return () => { unsubscribed.push(event); };
    },
  };
  // Set when the fake client's start() attaches the jsonrpc callback (real MonacoLanguageClient
  // does this as soon as the connection is created, before the handshake reply — the exact point
  // the hung-start scenario freezes at). stop() disposes it, mirroring the real client's teardown
  // of its connection, which is what actually unsubscribes the reader's Tauri listeners.
  let readerDisposable: { dispose(): void } | null = null;
  const makeClient = (opts: Parameters<LspClientDeps["makeClient"]>[0]): LspClientLike => {
    // Mirrors what the REAL MonacoLanguageClient does on start: attach the jsonrpc callback to
    // the reader, then send initialize through the writer — the exact race under test.
    return {
      async start() {
        readerDisposable = opts.transports.reader.listen(() => {});
        if (hangStart) return new Promise<void>(() => {});   // the hang the timeout breaks
        // SAFETY: initialize is the standard jsonrpc RequestMessage shape the real client sends —
        // jsonrpc/id/method/params — and the writer serializes whatever it receives verbatim.
        const initialize: RequestMessage = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
        await opts.transports.writer.write(initialize);
      },
      async stop() {
        clientStopCount++;
        readerDisposable?.dispose();
      },
      async sendNotification() {},
      async sendRequest() {
        return { items: [] };
      },
    };
  };
  const deps: LspClientDeps = {
    async startServer() {
      return { id: 1, scopeRoot: "/proj", workspaceRoot: wsRoot, initialized: false };
    },
    async stopServer(id: number) {
      stopped.push(id);
    },
    async stopProjectServer() {},
    bus,
    fileUri: (path) => ({ toString: () => path }),
    async ensureServices() {},
    makeClient,
  };
  return {
    deps,
    bus,
    handlers,
    written,
    stopped,
    unsubscribed,
    clientStopped: () => clientStopCount > 0,
    setGate: (g: Promise<void> | null) => { gate = g; },
    setWsRoot: (w: string) => { wsRoot = w; },
    setHangStart: (h: boolean) => { hangStart = h; },
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe("startLsp (#5857)", () => {
  beforeEach(() => setLspClientDeps(null));   // reset to the real (lazy) runtime between tests

  it("holds the first write until the reader's Tauri subscriptions are registered", async () => {
    const bus = makeDeps();
    let release!: () => void;
    bus.setGate(new Promise<void>(r => { release = r; }));
    setLspClientDeps(bus.deps);

    const started = startLsp("proj", null, "rust", "/proj/crate/src/main.rs");
    await tick();
    await tick();
    // Registration still in flight: initialize must NOT have gone out — its reply would be dropped.
    expect(bus.written).toEqual([]);

    release();
    const result = await started;
    expect(result.id).toBe(1);
    expect(bus.written[0]?.method).toBe("initialize");
  });

  it("sends initialize immediately once the subscriptions are registered", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/crate2");   // a fresh (workspaceRoot, language) key — no client reuse
    setLspClientDeps(bus.deps);

    const result = await startLsp("proj", null, "rust", "/proj/crate2/src/main.rs");
    expect(result.id).toBe(1);
    expect(bus.written[0]?.method).toBe("initialize");
  });

  it("stops the server and rejects when client.start() hangs past the start window", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/crate3");   // fresh key — the previous clients stay cached
    bus.setHangStart(true);          // the fake client's start() never resolves
    bus.deps.startTimeoutMs = 20;
    setLspClientDeps(bus.deps);

    await expect(startLsp("proj", null, "rust", "/proj/crate3/src/main.rs"))
      .rejects.toThrow(/timed out after 20ms/);
    expect(bus.stopped).toEqual([1]);   // the hung server was stopped for a fresh respawn
    // The abandoned client itself must be torn down too — otherwise the reader's two Tauri
    // subscriptions (lsp-message:<id>, lsp-closed:<id>) outlive the failed start and leak.
    expect(bus.clientStopped()).toBe(true);
    expect(bus.unsubscribed.sort()).toEqual(["lsp-closed:1", "lsp-message:1"]);
  });

  // ---- #6311: the 0.3.134 leak — the cap's timer could not be cancelled, so it fired at +30s
  // on a start that had ALREADY settled and stopped the healthy server (app-trace.log: "TIMED
  // OUT ... stopping server id=2" while rust-2.trace showed didOpen + diagnostics flowing). ----

  it("a start that settles BEFORE the cap never stops the server (0.3.134 leak)", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/leak");   // fresh key — the previous clients stay cached
    bus.deps.startTimeoutMs = 20;  // the cap fires 20ms in — long after start() has won the race
    setLspClientDeps(bus.deps);

    await startLsp("proj", null, "rust", "/proj/leak/src/main.rs");
    await new Promise(r => setTimeout(r, 60));   // well past the cap window
    expect(bus.stopped).toEqual([]);             // the healthy server was never stopped
    // The module's client map is shared across tests — scope the liveness check to this key.
    expect(lspClientRows().filter(r => r.workspaceRoot === "/proj/leak")).toHaveLength(1);
  });

  it("a start that lags the cap on a TALKING wire is never stopped; silence still fires it", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/talk");
    bus.deps.startTimeoutMs = 40;
    bus.setHangStart(true);          // start() never settles — the cap is the only way out
    setLspClientDeps(bus.deps);

    const started = startLsp("proj", null, "rust", "/proj/talk/src/main.rs");
    // rust-analyzer streams $/progress while it loads; every inbound frame re-arms the cap.
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "$/progress", params: {} });
    const pump = setInterval(() => {
      for (const h of bus.handlers.get("lsp-message:1") ?? []) h({ payload: frame });
    }, 5);
    await new Promise(r => setTimeout(r, 120));   // three cap windows of pure talk
    expect(bus.stopped).toEqual([]);              // a server that answered initialize lives
    clearInterval(pump);                          // the wire goes silent
    await expect(started).rejects.toThrow(/wire silence/);
    expect(bus.stopped).toEqual([1]);             // only NOW does the cap stop the server
  });

  it("a project switch abandons an in-flight start — no zombie client registers against the stopped server", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/zombie");   // a key no earlier test registered — the reuse path must not answer
    let release!: () => void;
    bus.setGate(new Promise<void>(r => { release = r; }));   // hold the reader's registration
    setLspClientDeps(bus.deps);

    const inFlight = startLsp("projA", null, "rust", "/projA/crate/src/main.rs");
    await tick();
    await tick();
    // The switch completes FIRST (in production stopLspProject is called the moment the project
    // changes; the in-flight start may still be anywhere in its handshake) — then the stalled
    // registration lands and the start tries to finish. It must refuse.
    const switched = stopLspProject("projA");
    await switched;
    release();
    await expect(inFlight).rejects.toThrow(/superseded by a project switch/);
    expect(lspClientRows()).toEqual([]);        // nothing registered against the stopped server
  });

  it("switch A→B→A: the switch-back start settles and the cap never kills its server", async () => {
    const bus = makeDeps();
    bus.deps.startTimeoutMs = 20;
    setLspClientDeps(bus.deps);

    bus.setWsRoot("/A/crate");
    await startLsp("projA", null, "rust", "/A/crate/src/main.rs");
    await stopLspProject("projA");
    bus.setWsRoot("/B/crate");
    await startLsp("projB", null, "typescript", "/B/src/app.ts");
    await stopLspProject("projB");

    bus.setWsRoot("/A/crate");
    await startLsp("projA", null, "rust", "/A/crate/src/main.rs");   // the switch-back start
    await new Promise(r => setTimeout(r, 60));   // past the cap window — the 0.3.134 leak fired here
    expect(bus.stopped).toEqual([]);             // the switch-back server survived the cap
    expect(lspClientRows()).toHaveLength(1);     // and its client is live for completions
  });

  // ---- #6311 (bounced): a client already live when an editor asks for it again — a remount, or
  // a second tab on the same crate — must still tell every isLspLive listener it exists. The
  // reuse branch used to return silently: an editor whose onLspChange subscription raced the
  // registration (or a status line re-deriving readiness) never heard the client was there. ----

  it("startLsp's reuse path notifies onLspChange listeners, not just a fresh start", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/reuse-notify");   // a fresh key
    setLspClientDeps(bus.deps);

    await startLsp("proj", null, "rust", "/proj/reuse-notify/src/main.rs");

    let calls = 0;
    const unsub = onLspChange(() => { calls++; });
    // Same (workspaceRoot, language) key — the map already has a client, so this hits the reuse
    // branch (lines around "reuse id=... client already registered"), not a fresh start.
    const result = await startLsp("proj", null, "rust", "/proj/reuse-notify/src/main.rs");
    unsub();

    expect(result.id).toBe(1);
    expect(calls).toBeGreaterThan(0);   // the reuse path must notify — a silent reuse is the bug
  });

  // The headless equivalent of the real-app typing drill (#6311, bounced from testing): the
  // operator's editor keeps its suggestions off because CodeView checked isLspLive keyed by the
  // project's SCOPE root, not the WORKSPACE root the client registry actually keys by — the two
  // differ for a nested crate (desktop/src-tauri inside the desktop project, exactly like
  // /proj/nested-crate below vs /proj). This is what CodeView's quickSuggestions computation now
  // must key on; the real drill (lspDrill.ts's typeAndExpectSuggest) proves the widget itself in
  // the live webview, which vitest cannot render.
  it("a client's key is the workspace root, not the scope root CodeView used to check (#6311)", async () => {
    const bus = makeDeps();
    bus.setWsRoot("/proj/nested-crate");
    setLspClientDeps(bus.deps);

    const result = await startLsp("proj", null, "rust", "/proj/nested-crate/src/main.rs");
    expect(result.scopeRoot).toBe("/proj");
    expect(result.workspaceRoot).toBe("/proj/nested-crate");
    // before (the bug): CodeView passed scopeRoot to isLspLive and saw no live client.
    expect(isLspLive("rust", result.scopeRoot)).toBe(false);
    // after (the fix): CodeView passes workspaceRoot and sees the live client.
    expect(isLspLive("rust", result.workspaceRoot)).toBe(true);
  });
});
