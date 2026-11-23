// @vitest-environment happy-dom

// #13913: herdr's `agent.prompt --wait` answer is the delivery receipt. These drills pin the
// composer to it at the IPC boundary: a successful herdr prompt is delivered with NO transcript
// match, a herdr error shows verbatim and never auto-resends, and a busy session whose wait
// timed out reads "sent, not yet picked up" — the transcript only clears that chip.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Composer } from "./Composer";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SAFETY: the Tauri IPC boundary as the webview provides it. pane_send answers with herdr's own
// verdict {outcome, error}; everything else gets the empty object.
const w = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: InvokeArgs) => Promise<string | string[] | { outcome: string; error: string | null }> } };

// A test-scoped localStorage stub — this happy-dom integration exposes none (Composer.test's pattern).
let store: Map<string, string>;
// SAFETY: the cast narrows globalThis to the exact optional key the stub owns; nothing else is
// asserted away, and the stub object itself is typed Storage by annotation, never by cast.
const stubGlobal = globalThis as { localStorage?: Storage };
const installStore = () => {
  store = new Map<string, string>();
  const stub: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  stubGlobal.localStorage = stub;
};

let host: HTMLDivElement;
let root: Root;

// The recorded IPC surface — pane_send's count is the assertion the whole card hangs on.
const sent: Array<{ cmd: string; args: InvokeArgs }> = [];
const paneSends = () => sent.filter(s => s.cmd === "pane_send");
// The fake herdr's answer for pane_send — what the Rust layer would relay of herdr's verdict.
let delivery: { outcome: string; error: string | null } = { outcome: "delivered", error: null };

beforeEach(() => {
  installStore();
  host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  root = createRoot(host);
  sent.length = 0;
  delivery = { outcome: "delivered", error: null };
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: InvokeArgs) => {
      sent.push({ cmd, args: args ?? {} });
      if (cmd === "pane_send") return Promise.resolve(delivery);
      return Promise.resolve("{}");
    },
  };
  // Fake ONLY the clock (chip judgments read Date.now at render): faking the timers
  // themselves would strand React's act flushing on a faked microtask queue.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

describe("herdr's own answer is the delivery receipt (#13913)", () => {
  const view = (userTexts: string[], working = false) => {
    act(() => root.render(
      <Composer
        project="alpha"
        target="pane-alpha"
        live
        liveWhy=""
        model="opus"
        modelSource="reported"
        working={working}
        userTexts={userTexts}
        context={{ tokens: null, window: 200000, frac: null }}
        fontStep="m"
        onFontStep={() => {}}
        onSent={() => {}}
        onLongRunChange={() => {}}
        onDispatch={() => {}}
      />,
    ));
  };

  // SAFETY: React dedupes a direct .value write; the prototype setter plus a bubbling input
  // event is the one write the controlled textarea always sees (Composer.test's pattern).
  const typeInto = async (el: HTMLTextAreaElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const sendDraft = async (text: string) => {
    const ta = host.querySelector("textarea");
    if (!ta) throw new Error("no textarea");
    await typeInto(ta, text);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    // The verdict is recorded in the send promise's .then — flush the microtask chain.
    await act(async () => {});
  };

  it("a fake herdr that succeeds marks delivered with no transcript match", async () => {
    view([]);
    await sendDraft("run the drill and report");
    expect(paneSends()).toHaveLength(1);

    // The transcript NEVER echoes the words — herdr's agent_prompted is the whole truth now.
    vi.setSystemTime(60_000);
    view([], true);
    await act(async () => {});
    view([], false);
    await act(async () => {});

    expect(paneSends()).toHaveLength(1);
    expect(host.textContent).not.toContain("not delivered");
    expect(host.textContent).not.toContain("not yet picked up");
    expect(host.textContent).not.toContain("delivering");
  });

  it("a fake herdr that errors shows the error verbatim and is never re-sent", async () => {
    delivery = { outcome: "stalled", error: "herdr socket read failed: connection reset" };
    view([]);
    await sendDraft("where are the drills");
    await act(async () => {});
    expect(host.textContent).toContain("herdr socket read failed: connection reset");
    expect(host.textContent).toContain("not delivered");

    // Turn boundaries, a working flip and a long silence: nothing re-sends — herdr already
    // refused once, and a missing transcript row proves nothing anymore.
    vi.setSystemTime(120_000);
    view([], true);
    await act(async () => {});
    view([], false);
    await act(async () => {});

    expect(paneSends()).toHaveLength(1);
  });

  it("a busy session whose wait timed out reads sent, not yet picked up — not failed", async () => {
    delivery = { outcome: "sent", error: "Sent, not yet picked up — the session is mid-turn; it will take the message at the next boundary." };
    view([]);
    await sendDraft("ship build 10 when it's green");
    await act(async () => {});

    expect(host.textContent).toContain("sent, not yet picked up");
    expect(host.textContent).toContain("ship build 10 when it's green");
    expect(host.textContent).not.toContain("not delivered");
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "retry")).toBe(false);

    // The transcript is display only: the echo renders and the chip clears — no resend, ever.
    expect(paneSends()).toHaveLength(1);
    vi.setSystemTime(30_000);
    view(["ship build 10 when it's green"]);
    await act(async () => {});
    expect(host.textContent).not.toContain("not yet picked up");
    expect(paneSends()).toHaveLength(1);
  });

  it("no code path scrapes the transcript for delivery — the pane_receipt_texts command is gone", async () => {
    delivery = { outcome: "sent", error: "Sent, not yet picked up — the session is mid-turn." };
    view([]);
    await sendDraft("anything at all");
    vi.setSystemTime(120_000);
    view([], true);
    await act(async () => {});
    view([], false);
    await act(async () => {});
    await act(async () => {});
    expect(sent.filter(s => s.cmd === "pane_receipt_texts")).toHaveLength(0);
  });
});
