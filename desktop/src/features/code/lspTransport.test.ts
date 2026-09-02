// The Tauri transport against a REAL vscode-jsonrpc connection (#5857): the reader must deliver
// every message the server sends — including ones that arrive before jsonrpc's listen() attaches
// (the handshake race: rust-analyzer answered initialize 7ms after the request, while the old
// reader's Tauri subscription was still being registered — rust-1.trace showed the handshake and
// then silence). The fake bus below implements the SAME LspBus seam the production code uses
// (TauriMessageReader/Writer take it as a constructor arg, defaulting to the real @tauri fns), so
// no module is mocked — the bus is injected, exactly as the app wires it.
import { describe, expect, it } from "vitest";
import type { LspBus } from "./lspTransport";

/** A JSON-RPC message on the wire, as the writer serializes it (vscode-jsonrpc's Message is a
 *  union; the transport only ever sends method/id-bearing envelopes). */
type WireMessage = { jsonrpc: string; method?: string; id?: number | string; params?: unknown };

/** A faithful in-memory implementation of the transport's LspBus seam. */
function makeBus(): LspBus & {
  written: WireMessage[];
  emit(event: string, payload: string | null): void;
  holdListens: boolean;
  pendingListens: Array<() => void>;
} {
  const handlers = new Map<string, Array<(ev: { payload: string | null }) => void>>();
  const written: WireMessage[] = [];
  const pendingListens: Array<() => void> = [];
  // SAFETY: the writer only ever invokes lsp_send with a serialized Message, so the wire record
  // IS the parsed envelope (method/id-bearing) — the assertion is the boundary parse, nothing more.
  const invokeFake = async <T>(cmd: string, args: { id: number; message: string }): Promise<T> => {
    if (cmd === "lsp_send" && args?.message) {
      // SAFETY: this is the one lsp_send shape the writer sends — a serialized JSON-RPC Message.
      written.push(JSON.parse(args.message) as WireMessage);
    }
    // SAFETY: the LspBus contract types invoke<T>; this fake only implements the lsp_send arm the
    // writer uses, which resolves to undefined (void) — asserting the generic return is the seam's
    // own contract, never a value invented here.
    return undefined as T;
  };
  // SAFETY: every emit in this file carries a string or null payload, which is exactly the union T
  // is constrained to; storing the handler under that container loses no value.
  const listenFake = async <T extends string | null>(event: string, handler: (ev: { payload: T }) => void) => {
    // SAFETY: the cast widens the handler's payload to the container the fake bus actually stores;
    // T is constrained to string|null so nothing outside that union is ever handed through.
    const boxed: (ev: { payload: string | null }) => void = handler as (ev: { payload: string | null }) => void;
    handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
    if (bus.holdListens) return new Promise<() => void>(res => pendingListens.push(() => res(() => {})));
    return Promise.resolve(() => {});
  };
  const bus = {
    written,
    holdListens: false,
    pendingListens,
    listen: listenFake,
    invoke: invokeFake,
    emit(event: string, payload: string | null) {
      for (const fn of handlers.get(event) ?? []) fn({ payload });
    },
  };
  return bus;
}

// The common api's connection machinery needs a runtime abstraction layer; the node build
// installs one (RAL is a shared singleton) and never touches the network for this test.
import "vscode-jsonrpc/node";
import { createMessageConnection } from "vscode-jsonrpc";
import { TauriMessageReader, TauriMessageWriter, traceKey } from "./lspTransport";

const tick = () => new Promise(r => setTimeout(r, 0));

describe("traceKey", () => {
  it("renders the key separator as ' · ', never a NUL byte", () => {
    const key = "/Users/sasha/proj\u0000rust";
    const rendered = traceKey(key);
    expect(rendered).not.toContain("\u0000");
    expect(rendered).toBe("/Users/sasha/proj · rust");
  });
});

describe("TauriMessageReader/Writer over a real jsonrpc connection", () => {
  it("runs the full handshake and keeps the pump alive after the first response", async () => {
    const bus = makeBus();
    const reader = new TauriMessageReader(7, undefined, bus);
    const writer = new TauriMessageWriter(7, bus);
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
    const bus = makeBus();
    const reader = new TauriMessageReader(9, undefined, bus);
    // The server talks BEFORE any connection listens — the 0.3.111 drop. The constructor-time
    // subscription must catch it and the buffer must hand it over on listen().
    bus.emit(`lsp-message:9`, JSON.stringify({ jsonrpc: "2.0", method: "test/early", params: {} }));

    const writer = new TauriMessageWriter(9, bus);
    const conn = createMessageConnection(reader, writer);
    const seen: string[] = [];
    conn.onNotification("test/early", () => { seen.push("early"); });
    conn.listen();
    await tick();
    expect(seen).toEqual(["early"]);
    conn.dispose();
  });

  it("fires onClose when the server's lsp-closed event arrives", async () => {
    const bus = makeBus();
    const reader = new TauriMessageReader(11, undefined, bus);
    const writer = new TauriMessageWriter(11, bus);
    const conn = createMessageConnection(reader, writer);
    const closed: boolean[] = [];
    conn.onClose(() => { closed.push(true); });
    conn.listen();
    bus.emit(`lsp-closed:11`, null);
    await tick();
    expect(closed).toEqual([true]);
    conn.dispose();
  });

  it("ready resolves once BOTH Tauri subscriptions are confirmed registered", async () => {
    // Tauri drops an event with no subscriber, so `initialize` must not go out before this
    // resolves — startLsp gates client.start() on it (#5857).
    const reader = new TauriMessageReader(13);
    await expect(reader.ready).resolves.toBeUndefined();
    expect(bus.handlers.get(`lsp-message:13`)).toHaveLength(1);
    expect(bus.handlers.get(`lsp-closed:13`)).toHaveLength(1);
  });
});

describe("TauriMessageReader.ready (#5857, the 0.3.113 miss)", () => {
  it("does not resolve until both Tauri registrations completed, so the client's first write cannot race them", async () => {
    const bus = makeBus();
    bus.holdListens = true;
    try {
      const reader = new TauriMessageReader(9, undefined, bus);
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
