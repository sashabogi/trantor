// @vitest-environment happy-dom

// #12913: after a session restart the panel can follow the SUCCESSOR transcript while a
// delivered send's echo sits in the pane's OWN transcript. These drills pin the receipt
// judgment — banner, auto-retry, manual retry — to the pane's own session, at the IPC boundary.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Composer } from "./Composer";
import { LOST_AFTER_MS } from "./streaming";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SAFETY: the Tauri IPC boundary as the webview provides it. pane_receipt_texts answers with the
// echo the pane's own transcript holds; everything else gets the empty object.
const w = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: InvokeArgs) => Promise<string | string[]> } };

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
let paneEcho: string[] = [];

beforeEach(() => {
  installStore();
  host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  root = createRoot(host);
  sent.length = 0;
  paneEcho = [];
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: InvokeArgs) => {
      sent.push({ cmd, args: args ?? {} });
      if (cmd === "pane_receipt_texts") return Promise.resolve(paneEcho);
      return Promise.resolve("{}");
    },
  };
  // Fake ONLY the clock (the lost-window judgment reads Date.now at render): faking the timers
  // themselves would strand React's act flushing on a faked microtask queue.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

describe("a restart-split receipt is judged against the pane's own transcript (#12913)", () => {
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
    // The pending is recorded in the send promise's .then — flush the microtask chain.
    await act(async () => {});
  };

  it("the echo in the pane's own transcript clears the pending — no banner, no auto-retry", async () => {
    view([]);
    await sendDraft("show me when the screenshots are on the canvas");
    expect(paneSends()).toHaveLength(1);

    // The restart: the panel re-anchors to the successor transcript (empty); the delivered
    // send's echo sits only in the transcript the pane's session actually wrote.
    paneEcho = ["show me when the screenshots are on the canvas"];
    vi.setSystemTime(LOST_AFTER_MS + 1_000);
    view([], true);
    await act(async () => {});
    await act(async () => {});
    view([], false); // the turn boundary — the old code re-typed the send here
    await act(async () => {});
    await act(async () => {});

    expect(paneSends()).toHaveLength(1);
    expect(host.textContent).not.toContain("not delivered");
    expect(host.textContent).not.toContain("delivering");
  });

  it("the manual retry checks the pane's own transcript first — delivered there, nothing resends", async () => {
    view([]);
    await sendDraft("ship build 10 when it's green");
    vi.setSystemTime(LOST_AFTER_MS + 1_000);
    view([]);
    await act(async () => {});
    await act(async () => {});
    expect(host.textContent).toContain("not delivered");

    // The echo lands in the pane's own transcript AFTER the banner's last check.
    paneEcho = ["ship build 10 when it's green"];
    const retryBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "retry");
    if (!retryBtn) throw new Error("no retry button");
    await act(async () => { retryBtn.click(); });
    await act(async () => {});
    await act(async () => {});

    expect(paneSends()).toHaveLength(1);
    expect(host.textContent).not.toContain("not delivered");
    expect(host.textContent).not.toContain("delivering");
  });

  it("a send with no echo anywhere still auto-retries exactly once at the turn boundary", async () => {
    view([]);
    await sendDraft("where are the drills");
    vi.setSystemTime(LOST_AFTER_MS + 1_000);
    view([], true);
    await act(async () => {});
    view([], false);
    await act(async () => {});
    await act(async () => {});

    expect(paneSends()).toHaveLength(2);
    expect(paneSends()[1].args).toEqual({ target: "pane-alpha", text: "where are the drills" });
  });
});
