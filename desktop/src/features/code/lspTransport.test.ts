// The Tauri transport against a REAL vscode-jsonrpc connection (#5857): the reader must deliver
// every message the server sends — including ones that arrive before jsonrpc's listen() attaches
// (the handshake race: rust-analyzer answered initialize 7ms after the request, while the old
// reader's Tauri subscription was still being registered — rust-1.trace showed the handshake and
// then silence). The fake bus below plays Rust: emit() is the server talking, written[] is what
// the client sent.
import { describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
  return {
    handlers,
    written: [] as Array<Record<string, unknown>>,
    /** When set, listen() registrations stay pending until the test releases them — the real
     *  IPC round trip made slow, so `ready` ordering is observable. */
    holdListens: false,
    pendingListens: [] as Array<() => void>,
    emit(event: string, payload: unknown) {
      for (const fn of handlers.get(event) ?? []) fn({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    const list = bus.handlers.get(event) ?? [];
    list.push(handler);
    bus.handlers.set(event, list);
    // Resolves asynchronously, like the real IPC round trip — delivery must not depend on it.
    if (bus.holdListens) return new Promise<() => void>(res => bus.pendingListens.push(() => res(() => {})));
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { message?: string }) => {
    if (cmd === "lsp_send" && args?.message) bus.written.push(JSON.parse(args.message));
    return Promise.resolve();
  },
}));

// The common api's connection machinery needs a runtime abstraction layer; the node build
// installs one (RAL is a shared singleton) and never touches the network for this test.
import "vscode-jsonrpc/node";
import { createMessageConnection } from "vscode-jsonrpc";
import { TauriMessageReader, TauriMessageWriter } from "./lspTransport";

const tick = () => new Promise(r => setTimeout(r, 0));

describe("TauriMessageReader/Writer over a real jsonrpc connection", () => {
  it("runs the full handshake and keeps the pump alive after the first response", async () => {
    const reader = new TauriMessageReader(7);
    const writer = new TauriMessageWriter(7);
    const conn = createMessageConnection(reader, writer);
    const progressed: string[] = [];
    conn.onNotification("$/progress", () => { progressed.push("progress"); });
    conn.listen();

    const init = conn.sendRequest("initialize", { processId: null });
    await tick();
    expect(bus.written[0]?.method).toBe("initialize");
    const reqId = bus.written[0]?.id;

    bus.emit(`lsp-message:7`, JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { capabilities: {} } }));
    await expect(init).resolves.toEqual({ capabilities: {} });

    await conn.sendNotification("initialized", {});
    await tick();
    expect(bus.written.map(m => m.method)).toEqual(["initialize", "initialized"]);

    // The pump still runs AFTER the handshake: a later server notification is delivered.
    bus.emit(`lsp-message:7`, JSON.stringify({ jsonrpc: "2.0", method: "$/progress", params: { token: "t", value: { kind: "end" } } }));
    await tick();
    expect(progressed).toEqual(["progress"]);
    conn.dispose();
  });

  it("buffers messages that arrive before jsonrpc's listen() attaches", async () => {
    const reader = new TauriMessageReader(9);
    // The server talks BEFORE any connection listens — the 0.3.111 drop. The constructor-time
    // subscription must catch it and the buffer must hand it over on listen().
    bus.emit(`lsp-message:9`, JSON.stringify({ jsonrpc: "2.0", method: "test/early", params: {} }));

    const writer = new TauriMessageWriter(9);
    const conn = createMessageConnection(reader, writer);
    const seen: string[] = [];
    conn.onNotification("test/early", () => { seen.push("early"); });
    conn.listen();
    await tick();
    expect(seen).toEqual(["early"]);
    conn.dispose();
  });

  it("fires onClose when the server's lsp-closed event arrives", async () => {
    const reader = new TauriMessageReader(11);
    const writer = new TauriMessageWriter(11);
    const conn = createMessageConnection(reader, writer);
    const closed: boolean[] = [];
    conn.onClose(() => { closed.push(true); });
    conn.listen();
    bus.emit(`lsp-closed:11`, null);
    await tick();
    expect(closed).toEqual([true]);
    conn.dispose();
  });
});

describe("TauriMessageReader.ready (#5857, the 0.3.113 miss)", () => {
  it("does not resolve until both Tauri registrations completed, so the client's first write cannot race them", async () => {
    bus.holdListens = true;
    try {
      const reader = new TauriMessageReader(9);
      let settled = false;
      void reader.ready.then(() => { settled = true; });
      await tick();
      await tick();
      expect(settled).toBe(false);
      expect(bus.pendingListens.length).toBe(2);
      for (const release of bus.pendingListens.splice(0)) release();
      await reader.ready;
      expect(settled).toBe(true);
    } finally {
      bus.holdListens = false;
    }
  });
});
