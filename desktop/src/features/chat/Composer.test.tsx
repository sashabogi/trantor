// @vitest-environment happy-dom
//
// The composer's drag handle, proven against the REAL component (#6070 bounce): the pure geometry
// was green while the built app's handle sat inert — the moves rode the element's own pointermove
// under WKWebView pointer capture and never arrived. The fix rides window listeners; this drill
// dispatches pointerdown → window pointermove → pointerup and asserts the height actually reaches
// the textarea's style and lands in localStorage. The Tauri surface is stubbed at its one real
// boundary (window.__TAURI_INTERNALS__) — the component's own try/catches do the rest.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, composerTakesDrop } from "./Composer";
import { clampComposerPx, maxComposerPx, minComposerPx } from "./composerHeight";
import { LOST_AFTER_MS } from "./streaming";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SAFETY: the Tauri IPC boundary as the webview provides it — invoke answers the autonomy read with
// an empty state; everything else the composer reaches is caught by its own try/catches. The cast
// names the one key happy-dom's window type does not carry.
const w = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<string> } };
w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve("{}") };

// A test-scoped localStorage stub — this happy-dom integration exposes none. Fresh per test, so
// every drill starts "nothing was ever persisted".
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

beforeEach(() => {
  installStore();
  host = document.createElement("div");
  document.body.appendChild(host);
  // SAFETY: the pane the composer measures against — happy-dom lays nothing out, so the host's
  // clientHeight is declared the way tabStrip.test.tsx declares the strip's width. 800px pane →
  // the 60% ceiling the drags below are asserted against.
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderComposer = () => {
  act(() => root.render(
    <Composer
      project="p"
      target="orch"
      live
      liveWhy=""
      model="opus"
      modelSource="reported"
      working={false}
      userTexts={[]}
      context={{ tokens: null, window: 200000, frac: null }}
      fontStep="m"
      onFontStep={() => {}}
      onSent={() => {}}
      onLongRunChange={() => {}}
      onDispatch={() => {}}
    />,
  ));
};

describe("the composer's drag handle (#6070 bounce)", () => {
  it("starts at the two-line floor when the content is smaller", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    expect(ta).toBeTruthy();
    expect(ta?.style.height).toBe(`${minComposerPx()}px`);
  });

  // One full drag: pointerdown on the rendered handle, moves and release on the window, all in
  // act so the state lands before the assertion. The box is bottom-anchored with the handle on
  // its TOP edge — an UPWARD drag (clientY decreasing) GROWS it, a downward one shrinks it.
  const drag = (handle: HTMLElement, fromY: number, toY: number) => {
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { clientY: fromY, pointerId: 1, bubbles: true, cancelable: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: toY, pointerId: 1, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientY: toY, pointerId: 1, bubbles: true }));
    });
  };

  it("an UPWARD drag GROWS the box — the code review's exact specimen (y=300 → y=200 grows ~100px)", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    const handle = host.querySelector<HTMLDivElement>("[role='separator']");
    expect(ta).toBeTruthy();
    expect(handle).toBeTruthy();
    if (!ta || !handle) return;

    const min = minComposerPx();
    const max = maxComposerPx(800);

    drag(handle, 300, 200);

    const expected = clampComposerPx(min + 100, min, max);
    // The height REACHED the style — the exact leg the operator's bounce said to prove — and the
    // direction is right: 100px of upward travel adds 100px, it does not shrink into the floor.
    expect(ta.style.height).toBe(`${expected}px`);
    expect(expected).toBe(min + 100);
    // …and the choice is remembered.
    expect(store.get("trantor.chat.composerHeight")).toBe(String(expected));
  });

  it("a DOWNWARD drag shrinks it, and the clamp holds both ends", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    const handle = host.querySelector<HTMLDivElement>("[role='separator']");
    expect(ta).toBeTruthy();
    expect(handle).toBeTruthy();
    if (!ta || !handle) return;

    const min = minComposerPx();
    const max = maxComposerPx(800);

    // Grow 200 first so there IS room to shrink…
    drag(handle, 300, 100);
    expect(ta.style.height).toBe(`${min + 200}px`);
    // …then shrink 80 of it back.
    drag(handle, 200, 280);
    expect(ta.style.height).toBe(`${min + 120}px`);
    // A violent downward drag parks exactly on the floor, never under it.
    drag(handle, 200, 20_000);
    expect(ta.style.height).toBe(`${min}px`);
    // A violent upward drag parks exactly on the ceiling, never over it.
    drag(handle, 500, -20_000);
    expect(ta.style.height).toBe(`${max}px`);
    expect(store.get("trantor.chat.composerHeight")).toBe(String(max));
  });
});

// #6147 — the webview's drop event is WINDOW-global: the composer and the genesis sheet both hear
// every drop. The gate is pure: a drop is the composer's only when the topmost element at the drop
// point is inside the composer root and no modal sheet is open.
describe("composerTakesDrop (#6147)", () => {
  it("refuses a null hit or a null root, and takes a hit inside the root", () => {
    const root = document.createElement("div");
    const inner = document.createElement("span");
    root.appendChild(inner);
    document.body.appendChild(root);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(composerTakesDrop(null, root)).toBe(false);
    expect(composerTakesDrop(inner, null)).toBe(false);
    expect(composerTakesDrop(inner, root)).toBe(true);
    expect(composerTakesDrop(outside, root)).toBe(false);
    root.remove(); outside.remove();
  });
  it("stands down while a modal sheet is open, even for a hit inside the root", () => {
    const root = document.createElement("div");
    const inner = document.createElement("span");
    root.appendChild(inner);
    document.body.appendChild(root);
    const sheet = document.createElement("div");
    sheet.setAttribute("data-modal-sheet-open", "");
    document.body.appendChild(sheet);
    expect(composerTakesDrop(inner, root)).toBe(false);
    sheet.remove();
    expect(composerTakesDrop(inner, root)).toBe(true);
    root.remove();
  });
});

// #6250 — a pending send belongs to the project and pane it was DELIVERED to, never to the
// selection the composer shows now. The trace this drills: a message sent to trantor, the
// operator switched to hive-digital, and the turn boundary there judged the trantor pending
// against hive-digital's transcript, read it lost, and typed it into hive-digital's pane
// eleven seconds later. Every drill below crosses that exact switch at the REAL IPC boundary
// (the stub records pane_send's args) with the clock pushed past LOST_AFTER_MS, because a
// pending within its grace window can never look lost and so never drills the bug.
describe("a pending send keeps its own project and pane (#6250)", () => {
  // The recorded IPC surface — pane_send's target is the assertion the whole card hangs on.
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const paneSends = () => sent.filter(s => s.cmd === "pane_send");
  const installIpc = () => {
    sent.length = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        sent.push({ cmd, args: args ?? {} });
        return Promise.resolve("{}");
      },
    };
  };

  // Fake ONLY the clock (the lost-window judgment reads Date.now at render): faking the timers
  // themselves would strand React's act flushing on a faked microtask queue.
  beforeEach(() => {
    installIpc();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve("{}") };
  });

  // Re-render the SAME root — a project switch is a prop change on one live instance, which is
  // precisely why the pendings survived the switch and were re-judged against the new pane.
  const view = (project: string, target: string, userTexts: string[], working = false) => {
    act(() => root.render(
      <Composer
        project={project}
        target={target}
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
  // event is the one write the controlled textarea always sees (GenesisSheet.test's pattern).
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

  it("a send to project A, a switch to B, B's turn boundary: B's pane receives nothing, and A's receipt still clears it", async () => {
    view("alpha", "pane-alpha", []);
    await sendDraft("where are the drills");
    expect(paneSends()).toEqual([{ cmd: "pane_send", args: { target: "pane-alpha", text: "where are the drills" } }]);
    expect(host.textContent).toContain("delivering");

    // The switch, then the clock past the lost window, then B's turn boundary (working flips
    // true → false). The old code judged the alpha pending against B's empty transcript here
    // and re-sent it into pane-beta.
    vi.setSystemTime(LOST_AFTER_MS + 1_000);
    view("beta", "pane-beta", []);
    view("beta", "pane-beta", [], true);
    view("beta", "pane-beta", [], false);
    await act(async () => {});

    expect(paneSends()).toHaveLength(1); // nothing new, least of all to B's pane
    expect(paneSends().every(s => s.args.target === "pane-alpha")).toBe(true);
    expect(host.textContent).not.toContain("not delivered");
    expect(host.textContent).not.toContain("delivering"); // foreign pendings don't render in B

    // Back to A: its transcript (backfilled on the switch) echoes the text and the receipt
    // clears the pending it always belonged to.
    view("alpha", "pane-alpha", ["where are the drills"]);
    await act(async () => {});
    expect(host.textContent).not.toContain("delivering");
    expect(paneSends()).toHaveLength(1);
  });

  it("the selected project's transcript never clears another project's pending — identical text in B is not a receipt", async () => {
    view("alpha", "pane-alpha", []);
    await sendDraft("where are the drills");
    // B's transcript contains the very same words (the same message sent to both projects):
    // the false-delivered shape. The pending must NOT read them as its own receipt.
    view("beta", "pane-beta", ["where are the drills"]);
    await act(async () => {});
    // Back on A with nothing arrived yet — within the grace window the pending is still held.
    view("alpha", "pane-alpha", []);
    expect(host.textContent).toContain("delivering");
    expect(paneSends()).toHaveLength(1);
    // And A's real receipt clears it.
    view("alpha", "pane-alpha", ["where are the drills"]);
    await act(async () => {});
    expect(host.textContent).not.toContain("delivering");
  });

  it("the manual retry sends to the pending's own pane, not the selection", async () => {
    view("alpha", "pane-alpha", []);
    await sendDraft("where are the drills");
    vi.setSystemTime(LOST_AFTER_MS + 1_000);
    // No working transition ever fires, so the auto-retry stays out of this drill: the lost
    // banner is judged at render, in the pending's own project.
    view("alpha", "pane-alpha", ["some unrelated turn"]);
    expect(host.textContent).toContain("not delivered");
    const retry = [...host.querySelectorAll("button")].find(b => b.textContent === "retry");
    if (!retry) throw new Error("no retry button");
    await act(async () => { retry.click(); });
    await act(async () => {});
    const sends = paneSends();
    expect(sends).toHaveLength(2);
    expect(sends[1].args).toEqual({ target: "pane-alpha", text: "where are the drills" });
    // The retried send is pending again — held, within its fresh grace window.
    expect(host.textContent).toContain("delivering");
  });
});
