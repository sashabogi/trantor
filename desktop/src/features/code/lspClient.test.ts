// startLsp's side of the #5857 handshake race: the client's first write (initialize) must not
// reach `lsp_send` before the reader's Tauri subscriptions are confirmed registered — Tauri
// drops an event with no subscriber, so a reply Rust emits in that window is lost and the start
// hangs forever (rust-1.trace: initialize out, result in 7ms, then silence). The listen mock
// holds the registration gate open until the test releases it; the fake MonacoLanguageClient
// drives the real transport like the real one does (attach jsonrpc's callback, write initialize).
import { beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
  return {
    handlers,
    written: [] as Array<Record<string, unknown>>,
    stopped: [] as number[],
    gate: null as Promise<void> | null,
    wsRoot: "/proj/crate",
    emit(event: string, payload: unknown) {
      for (const fn of handlers.get(event) ?? []) fn({ payload });
    },
    reset() {
      this.handlers.clear();
      this.written.length = 0;
      this.stopped.length = 0;
      this.gate = null;
      this.wsRoot = "/proj/crate";
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    const list = bus.handlers.get(event) ?? [];
    list.push(handler);
    bus.handlers.set(event, list);
    const registered = Promise.resolve(() => {});
    // A slow registration IPC: the backend must not treat the listener as live until this resolves.
    return bus.gate ? bus.gate.then(() => registered) : registered;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "lsp_start") {
      return Promise.resolve({ id: 1, scopeRoot: "/proj", workspaceRoot: bus.wsRoot, initialized: false });
    }
    if (cmd === "lsp_send" && typeof args?.message === "string") bus.written.push(JSON.parse(args.message));
    if (cmd === "lsp_stop") bus.stopped.push(args?.id as number);
    return Promise.resolve();
  },
}));

type FakeTransports = {
  reader: { listen(cb: (msg: unknown) => void): { dispose(): void } };
  writer: { write(msg: unknown): Promise<void> };
};

vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: class {
    constructor(private readonly opts: { messageTransports: FakeTransports }) {}
    async start() {
      this.opts.messageTransports.reader.listen(() => {});
      await this.opts.messageTransports.writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    }
    async stop() {}
  },
}));
vi.mock("monaco-languageclient/vscodeApiWrapper", () => ({
  MonacoVscodeApiWrapper: class { async start() {} },
}));
vi.mock("vscode", () => ({ Uri: { file: (p: string) => ({ toString: () => p }) } }));
vi.mock("./monacoSetup", () => ({}));
vi.mock("./lspDocuments", () => ({ attachOpenDocuments: () => {}, setDocClientRows: () => {} }));

import { startLsp } from "./lspClient";

const tick = () => new Promise(r => setTimeout(r, 0));

describe("startLsp (#5857)", () => {
  beforeEach(() => bus.reset());

  it("holds the first write until the reader's Tauri subscriptions are registered", async () => {
    let release!: () => void;
    bus.gate = new Promise<void>(r => { release = r; });

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
    bus.wsRoot = "/proj/crate2"; // a fresh (workspaceRoot, language) key — no client reuse
    const result = await startLsp("proj", null, "rust", "/proj/crate2/src/main.rs");
    expect(result.id).toBe(1);
    expect(bus.written[0]?.method).toBe("initialize");
  });
});
