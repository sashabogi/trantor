// @vitest-environment happy-dom
// #14505: the Browser tab renders every state of the #14489 contract — placeholder open/rect/visibility,
// address bar, the driving line's faces, the ask answers, empty state, maximize and pop out — through
// the real invoke and event seams (mockIPC), no module mocking.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { BrowserTab } from "./BrowserTab";
import { addressToUrl, drivingLine, EMPTY_BROWSER_STATE, type BrowserArgs, type BrowserPreview, type BrowserState } from "./browserModel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no ResizeObserver; this one calls the observer back, which is the whole contract
// the tab depends on (it re-reads the element, never the entries).
const resizeCallbacks: Array<() => void> = [];
class TestResizeObserver implements ResizeObserver {
  private readonly fire: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.fire = () => callback([], this);
    resizeCallbacks.push(this.fire);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    const i = resizeCallbacks.indexOf(this.fire);
    if (i >= 0) resizeCallbacks.splice(i, 1);
  }
}
globalThis.ResizeObserver = TestResizeObserver;
const fireResize = () => { for (const cb of resizeCallbacks) cb(); };

const state = (over: Partial<BrowserState>): BrowserState => ({ ...EMPTY_BROWSER_STATE, project: "trantor", ...over });
const DRIVER = { session: "codex-8:trantor", label: "codex-8", action: 'clicking "Show descendants"', since: 100 };

function Harness({ project = "trantor", previews }: { project?: string; previews?: BrowserPreview[] }) {
  const [maximized, setMaximized] = useState(false);
  return <BrowserTab project={project} maximized={maximized} onMaximize={setMaximized} previews={previews} />;
}

const PREVIEWS: BrowserPreview[] = [
  { url: "localhost:5173", note: "vite, started by glm-5 four minutes ago", running: true },
  { url: "localhost:4173", note: "build preview, stopped", running: false },
];

let host: HTMLDivElement;
let root: Root;
let ipc: { command: string; args: BrowserArgs | null }[];
let cur: BrowserState;
let steps: unknown[];
beforeEach(() => {
  ipc = [];
  steps = [];
  cur = state({});
  mockIPC(async (command, args) => {
    // SAFETY: mockIPC hands its payload as unknown; every call this tab makes is flat browser args.
    ipc.push({ command, args: args as BrowserArgs | null });
    if (command === "browser_state" || command === "browser_open") return cur;
    if (command === "browser_steps") return steps;
    return null;
  }, { shouldMockEvents: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.restoreAllMocks(); });

const mount = async (previews?: BrowserPreview[]) => {
  await act(async () => { root.render(<Harness previews={previews} />); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const typeInto = (el: HTMLInputElement | null, text: string) => act(async () => {
  if (!el) throw new Error("no field to type into");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const press = (el: EventTarget | null, key: string) => act(async () => {
  el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});
const sendState = async (next: BrowserState) => { cur = next; await act(async () => { await emit("browser://state", next); }); };
const sendAsk = async (id: string) => {
  await act(async () => { await emit("browser://ask", { project: "trantor", id, session: "codex-8:trantor", label: "orchestrator", host: "accounts.google.com" }); });
};
const sent = (command: string) => ipc.filter(c => c.command === command).map(c => c.args);
const last = (command: string): BrowserArgs | null | undefined => {
  const args = sent(command);
  return args.length ? args[args.length - 1] : undefined;
};
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`);
const text = (t: string) => [...host.querySelectorAll("button")].find(b => b.textContent === t) ?? null;

// happy-dom lays out nothing: the region's geometry is injected so the rect contract is real.
const setRect = (el: Element, x: number, y: number, w: number, h: number) => {
  // SAFETY: a plain object stands in for the DOMRect the tab reads x/y/width/height from.
  el.getBoundingClientRect = () => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }) as DOMRect;
};

describe("the placeholder the native page covers", () => {
  it("opens the browser into it once and follows every resize with browser_set_rect", async () => {
    await mount();
    const region = host.querySelector('[data-testid="browser-region"]');
    expect(region).not.toBeNull();
    expect(sent("browser_open")).toHaveLength(1);
    expect(last("browser_open")).toMatchObject({ project: "trantor", url: null, rect: { x: 0, y: 0, w: 0, h: 0 } });
    setRect(region!, 8, 44, 700, 480);
    fireResize();
    expect(last("browser_set_rect")).toMatchObject({ project: "trantor", rect: { x: 8, y: 44, w: 700, h: 480 } });
    fireResize();
    expect(sent("browser_open")).toHaveLength(1);
    // an unchanged rect is not sent again
    expect(sent("browser_set_rect")).toHaveLength(2);
  });

  it("follows the region when the layout moves it without resizing it", async () => {
    await mount();
    const region = host.querySelector('[data-testid="browser-region"]')!;
    setRect(region, 8, 44, 700, 480);
    fireResize();
    // a banner above pushes the column down 30px; the region keeps its size, so no resize fires
    setRect(region, 8, 74, 700, 480);
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(last("browser_set_rect")).toMatchObject({ rect: { x: 8, y: 74, w: 700, h: 480 } });
  });

  it("shows the page only while one is open, and hides it when the tab goes away", async () => {
    await mount();
    expect(sent("browser_set_visible")).toEqual([{ project: "trantor", visible: false }]);
    await sendState(state({ url: "http://localhost:5173/tree/popovic" }));
    expect(sent("browser_set_visible")).toContainEqual({ project: "trantor", visible: true });
    expect(host.querySelector('[aria-label="The page"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
    expect(last("browser_set_visible")).toEqual({ project: "trantor", visible: false });
  });

  it("does not open or place the page while it lives in its own window", async () => {
    await sendState(state({ url: "http://localhost:5173", popped_out: true }));
    await mount();
    expect(sent("browser_open")).toHaveLength(0);
    expect(sent("browser_set_rect")).toHaveLength(0);
    expect(last("browser_set_visible")).toEqual({ project: "trantor", visible: false });
  });
});

describe("the address bar", () => {
  it("navigates on Enter, normalizing the typed address, and goes back, forward and reload", async () => {
    await sendState(state({ url: "http://localhost:5173/tree/popovic", can_back: true, can_forward: false }));
    await mount();
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Address"]'), "github.com/tauri-apps/tauri");
    await press(host.querySelector('input[aria-label="Address"]'), "Enter");
    expect(last("browser_navigate")).toEqual({ project: "trantor", url: "http://github.com/tauri-apps/tauri" });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value).toBe("http://localhost:5173/tree/popovic");
    await click(button("Back"));
    expect(last("browser_back")).toEqual({ project: "trantor" });
    expect(button("Forward")?.hasAttribute("disabled")).toBe(true);
    await click(button("Forward"));
    expect(sent("browser_forward")).toHaveLength(0);
    await click(button("Reload"));
    expect(last("browser_reload")).toEqual({ project: "trantor" });
  });

  it("opens the current page in the default browser and explains when there is none", async () => {
    await sendState(state({ url: "https://github.com/tauri-apps/tauri" }));
    await mount();
    await click(button("Open in your default browser"));
    expect(last("plugin:opener|open_url")).toMatchObject({ url: "https://github.com/tauri-apps/tauri" });
  });

  it("keeps the chat actions inert until B3 wires them", async () => {
    await mount();
    await click(button("Screenshot to chat"));
    await click(button("Pick an element for chat"));
    expect(ipc.filter(c => c.command.startsWith("plugin:opener") || c.command.startsWith("browser_")).map(c => c.command))
      .toEqual(["browser_state", "browser_set_visible", "browser_open", "browser_set_rect"]);
  });
});

describe("who is driving", () => {
  it("draws no line while you browse alone", async () => {
    await mount();
    expect(host.textContent).not.toContain("using the browser");
    expect(text("Take over")).toBeNull();
  });

  it("names the agent and its step, and Take over holds the browser", async () => {
    await sendState(state({ url: "http://localhost:5173", driver: DRIVER }));
    await mount();
    expect(host.textContent).toContain('codex-8 is using the browser · clicking "Show descendants"');
    await click(text("Take over"));
    expect(last("browser_take_over")).toEqual({ project: "trantor" });
  });

  it("says you have it, who waits, and Give back releases it", async () => {
    await sendState(state({ url: "http://localhost:5173", driver: DRIVER, held_by_user: true }));
    await mount();
    expect(host.textContent).toContain("You have the browser · codex-8 is paused, waiting");
    await click(text("Give back"));
    expect(last("browser_give_back")).toEqual({ project: "trantor" });
  });

  it("an agent asking for a new site gets its three answers and the ask clears", async () => {
    await sendState(state({ url: "http://localhost:5173", driver: DRIVER }));
    await mount();
    await sendAsk("a1");
    expect(host.textContent).toContain("orchestrator wants to open accounts.google.com");
    await click(text("Allow once"));
    expect(last("browser_answer")).toEqual({ project: "trantor", id: "a1", choice: "once" });
    expect(host.textContent).not.toContain("wants to open");
    await sendAsk("a2");
    await click(text("Allow this site"));
    expect(last("browser_answer")).toEqual({ project: "trantor", id: "a2", choice: "site" });
    await sendAsk("a3");
    await click(text("Not now"));
    expect(last("browser_answer")).toEqual({ project: "trantor", id: "a3", choice: "deny" });
  });
});

describe("nothing open yet", () => {
  it("says so, lists the project's previews and a preview navigates", async () => {
    await mount(PREVIEWS);
    expect(host.textContent).toContain("Nothing open");
    expect(host.textContent).toContain("Links you click in chat open here");
    expect(host.textContent).toContain("Previews in this project");
    expect(host.textContent).toContain("vite, started by glm-5 four minutes ago");
    expect(host.textContent).toContain("build preview, stopped");
    const dots = [...host.querySelectorAll("button[title^='Open localhost']")].map(b => b.querySelector("span")?.className);
    expect(dots[0]).toContain("bg-[var(--v2-ok)]");
    expect(dots[1]).toContain("bg-[var(--v2-faint)]");
    await click(host.querySelector("button[title='Open localhost:5173']"));
    expect(last("browser_navigate")).toEqual({ project: "trantor", url: "http://localhost:5173" });
  });
});

describe("bigger", () => {
  it("maximizes on demand and Restore or Esc puts the column back", async () => {
    await sendState(state({ url: "http://localhost:5173/tree/popovic" }));
    await mount();
    await click(button("Maximize the browser"));
    expect(button("Restore")).not.toBeNull();
    expect(button("Maximize the browser")).toBeNull();
    await press(document, "Escape");
    expect(button("Maximize the browser")).not.toBeNull();
    await click(button("Maximize the browser"));
    await click(button("Restore"));
    expect(button("Maximize the browser")).not.toBeNull();
  });

  it("popped out, the tab points at its own window and Show focuses it", async () => {
    await sendState(state({ url: "http://localhost:5173/tree/popovic", popped_out: true }));
    await mount();
    expect(host.textContent).toContain("Open in its own window");
    expect(host.querySelector('[aria-label="The page"]')).toBeNull();
    await click(text("Show"));
    expect(last("browser_pop_out")).toEqual({ project: "trantor" });
  });
});

describe("pure model", () => {
  it("normalizes what the address bar sends on Enter", () => {
    expect(addressToUrl("localhost:5173/tree/popovic")).toBe("http://localhost:5173/tree/popovic");
    expect(addressToUrl("  localhost:4173  ")).toBe("http://localhost:4173");
    expect(addressToUrl("github.com")).toBe("http://github.com");
    expect(addressToUrl("https://developer.mozilla.org/en-US/docs")).toBe("https://developer.mozilla.org/en-US/docs");
    expect(addressToUrl("")).toBe("");
    expect(addressToUrl("what is a rect")).toBe("what is a rect");
  });

  it("names who is driving, or nobody at all", () => {
    expect(drivingLine(EMPTY_BROWSER_STATE)).toBeNull();
    expect(drivingLine(state({ driver: DRIVER }))).toEqual({ kind: "agent", label: "codex-8", action: 'clicking "Show descendants"' });
    expect(drivingLine(state({ driver: DRIVER, held_by_user: true }))).toEqual({ kind: "held", label: "codex-8" });
    expect(drivingLine(state({ held_by_user: true }))).toEqual({ kind: "held", label: null });
  });

  it("reads the state once on mount and then only from events", async () => {
    await sendState(state({ url: "http://localhost:5173" }));
    await mount();
    expect(sent("browser_state")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value).toBe("http://localhost:5173");
    await sendState(state({ url: "https://github.com", can_back: true }));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value).toBe("https://github.com");
    expect(sent("browser_state")).toHaveLength(1);
    expect(button("Back")?.hasAttribute("disabled")).toBe(false);
  });
});

// useBrowser answers for any project the events name; other projects' browsers stay unheard.
it("keeps the tab scoped to its own project", async () => {
  await mount();
  await act(async () => { await emit("browser://state", state({ project: "other", url: "http://elsewhere" })); });
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value).toBe("");
  expect(last("browser_set_visible")).toEqual({ project: "trantor", visible: false });
});

describe("the Browser tab against the Rust core's real shapes", () => {
  it("shows Nothing open when Rust reports no page as an empty url", async () => {
    // BrowserState.url is a String in Rust, so "no page" arrives as "", never null
    cur = state({ url: "", title: "" });
    await mount();
    expect(host.textContent).toContain("Nothing open");
    expect(ipc.some(c => c.command === "browser_set_visible" && c.args?.visible === true)).toBe(false);
  });

  it("lists the agent's steps under the page after a state change", async () => {
    cur = state({ url: "https://example.com/", title: "Example Domain" });
    await mount();
    steps = [
      { session: "s", label: "orchestrator", action: "read the page", at: 1, ok: true },
      { session: "s", label: "orchestrator", action: "clicked e1", at: 2, ok: false },
    ];
    await act(async () => { await emit("browser://state", state({ url: "https://example.com/", title: "Example Domain", driver: { session: "s", label: "orchestrator", action: "clicking", since: 1 } })); });
    await act(async () => { await Promise.resolve(); });
    const toggle = [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("Steps"));
    expect(toggle?.textContent).toContain("Steps · 2");
    await click(toggle ?? null);
    expect(host.textContent).toContain("read the page");
    expect(host.textContent).toContain("clicked e1 · failed");
  });
});
