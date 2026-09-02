// startLsp's side of the #5857 handshake race: the client's first write (initialize) must not
// reach `lsp_send` before the reader's Tauri subscriptions are confirmed registered — Tauri
// drops an event with no subscriber, so a reply Rust emits in that window is lost and the start
// hangs forever (rust-1.trace: initialize out, result in 7ms, then silence). lspClient reaches
// tauri/monaco ONLY through its injected deps (setLspClientDeps — the same seam setDocClientRows
// uses), so the test drives the real startLsp over a faithful in-memory bus and fake client:
// no module mocking, and no monaco import (which cannot load under node).
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestMessage } from "vscode-jsonrpc";
import { setLspClientDeps, startLsp, type LspClientDeps, type LspClientLike } from "./lspClient";
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
});
