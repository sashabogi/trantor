// @vitest-environment happy-dom
// #14516: every B5 control against the contract's shapes — the page strip (D), the F1 toolbar and
// More menu, the find bar (F3), the device bar and letterbox (F2), the panel (F4) and the keyboard
// chords — through the real invoke and event seams (mockIPC), no module mocking.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { BrowserTab } from "./BrowserTab";
import {
  ago, addressToUrl, clampZoom, DEVICE_PRESETS, EMPTY_BROWSER_STATE, hostOf, pageLabel, USER_AGENTS,
  zoomPercent, zoomStep, type BrowserArgs, type BrowserDevice, type BrowserFavorite, type BrowserHistoryEntry,
  type BrowserPermission, type BrowserState,
} from "./browserModel";

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

const state = (over: Partial<BrowserState>): BrowserState => ({ ...EMPTY_BROWSER_STATE, project: "trantor", ...over });
const DRIVER = { session: "codex-8:trantor", label: "codex-8", action: "reading the page", since: 100 };
const page = (id: string, url: string, driver: typeof DRIVER | null = null): BrowserState["pages"][number] =>
  ({ id, url, title: "", loading: false, driver });
const IPHONE: BrowserDevice = { name: "iPhone 15", w: 393, h: 852, mobile: true };
const TWO_PAGES = [page("p1", "http://localhost:5173/tree/popovic", { ...DRIVER, label: "orchestrator" }), page(" p2", "https://github.com/tauri-apps")];
const PAGED = (over: Partial<BrowserState> = {}): BrowserState =>
  state({ url: "http://localhost:5173/tree/popovic", title: "Popović line", active_page: "p1", pages: TWO_PAGES, ...over });

function Harness() {
  const [maximized, setMaximized] = useState(false);
  return <BrowserTab project="trantor" maximized={maximized} onMaximize={setMaximized} />;
}

let host: HTMLDivElement;
let root: Root;
let ipc: { command: string; args: BrowserArgs | null }[];
let cur: BrowserState;
let findFound: boolean;
let inspectError: string | null;
let history: BrowserHistoryEntry[];
let favorites: BrowserFavorite[];
let permissions: BrowserPermission[];
const NOW = 1_000_000;
beforeEach(() => {
  ipc = [];
  cur = state({});
  findFound = true;
  inspectError = null;
  history = [];
  favorites = [];
  permissions = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  mockIPC(async (command, args) => {
    // SAFETY: mockIPC hands its payload as unknown; every call this tab makes is flat browser args.
    ipc.push({ command, args: args as BrowserArgs | null });
    if (command === "browser_state" || command === "browser_open") return cur;
    if (command === "browser_find") return { found: findFound };
    if (command === "browser_history") return history;
    if (command === "browser_favorites") return favorites;
    if (command === "browser_permissions") return permissions;
    if (command === "browser_inspect") { if (inspectError) throw new Error(inspectError); return null; }
    return null;
  }, { shouldMockEvents: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { root.unmount(); });
  host.remove();
  clearMocks();
  vi.restoreAllMocks();
});

const mount = async () => { await act(async () => { root.render(<Harness />); }); };
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const typeInto = (el: HTMLInputElement | null, text: string) => act(async () => {
  if (!el) throw new Error("no field to type into");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const press = (el: EventTarget | null, key: string, shift = false) => act(async () => {
  el?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
});
const chord = (key: string, shift = false) => act(async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
});
const sendState = async (next: BrowserState) => { cur = next; await act(async () => { await emit("browser://state", next); }); };
const sent = (command: string) => ipc.filter(c => c.command === command).map(c => c.args);
const last = (command: string): BrowserArgs | null | undefined => {
  const args = sent(command);
  return args.length ? args[args.length - 1] : undefined;
};
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`);
// Menu rows carry kbd hints and trailing values, and panel rows carry hosts and ages, so a row is
// named by the words it starts with.
const text = (t: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith(t) ?? false) ?? null;
const panelTab = (label: string) => [...host.querySelectorAll('[role="dialog"] [role="tab"]')].find(t => t.textContent?.startsWith(label)) ?? null;
const openMore = async () => { await click(button("More")); };
const region = () => host.querySelector('[data-testid="browser-region"]');

describe("the page strip (artboard D)", () => {
  it("stays hidden with zero or one page", async () => {
    await mount();
    expect(host.querySelector('[role="tablist"][aria-label="Pages"]')).toBeNull();
    await sendState(PAGED({ pages: [TWO_PAGES[0]] }));
    expect(host.querySelector('[role="tablist"][aria-label="Pages"]')).toBeNull();
  });

  it("shows one tab per page, the driven one named, and selects and closes through the commands", async () => {
    await sendState(PAGED());
    await mount();
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Pages"] [role="tab"]')];
    expect(tabs.map(t => t.textContent)).toEqual(["localhost:5173/tree/popovic· orchestrator", "github.com/tauri-apps"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    await click(tabs[1]);
    expect(last("browser_select_page")).toEqual({ project: "trantor", page: " p2" });
    await click(button("Close localhost:5173/tree/popovic"));
    expect(last("browser_close_page")).toEqual({ project: "trantor", page: "p1" });
  });

  it("opens a new page from the strip's +", async () => {
    await sendState(PAGED());
    await mount();
    await click(host.querySelector('[role="tablist"][aria-label="Pages"] button[aria-label="New page"]'));
    expect(last("browser_new_page")).toEqual({ project: "trantor", url: null });
  });
});

describe("the F1 toolbar", () => {
  it("keeps the wave-1 buttons and gains Inspector and Devices", async () => {
    await sendState(PAGED());
    await mount();
    for (const label of ["Back", "Forward", "Reload", "Maximize the browser", "Pop out into its own window", "Inspect the page", "Devices", "More"]) {
      expect(button(label)).not.toBeNull();
    }
    expect(button("Screenshot to chat")).toBeNull();
    expect(button("Pick an element for chat")).toBeNull();
    expect(button("Open in your default browser")).toBeNull();
  });

  it("runs the Inspector and shows nothing when it opens", async () => {
    await sendState(PAGED());
    await mount();
    await click(button("Inspect the page"));
    expect(sent("browser_inspect")).toHaveLength(1);
    expect(host.textContent).not.toContain("could not open");
  });

  it("shows the Inspector's error in a small notice, and it can be dismissed", async () => {
    inspectError = "the Web Inspector needs a debug build";
    await sendState(PAGED());
    await mount();
    await click(button("Inspect the page"));
    expect(host.textContent).toContain("The Inspector could not open: the Web Inspector needs a debug build");
    await click(button("Dismiss the notice"));
    expect(host.textContent).not.toContain("could not open");
  });

  it("toggles the device bar from the Devices button", async () => {
    await sendState(PAGED());
    await mount();
    expect(button("Devices")?.getAttribute("aria-pressed")).toBe("false");
    await click(button("Devices"));
    expect(button("Devices")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("iPhone 15");
    expect(host.textContent).toContain("Done");
    await click(button("Devices"));
    expect(host.textContent).not.toContain("iPhone 15");
  });
});

describe("the More menu (artboard F1)", () => {
  it("new page and close page run the page commands; close page explains when there is none", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    await click(text("New page"));
    expect(last("browser_new_page")).toEqual({ project: "trantor", url: null });
    await openMore();
    await click(text("Close page"));
    expect(last("browser_close_page")).toEqual({ project: "trantor", page: "p1" });
    await sendState(state({ pages: [], active_page: "" }));
    await openMore();
    expect(text("Close page")?.hasAttribute("disabled")).toBe(true);
  });

  it("zoom steps by a tenth, clamps at the contract's bounds, and Reset clears the level", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    expect(host.querySelector('[role="menu"]')?.textContent).toContain("100%");
    await click(button("Zoom out"));
    expect(last("browser_zoom")).toEqual({ project: "trantor", level: 0.9 });
    await click(button("Zoom in"));
    expect(last("browser_zoom")).toEqual({ project: "trantor", level: 1.1 });
    await click(text("Reset"));
    expect(last("browser_zoom")).toEqual({ project: "trantor", level: null });
    await sendState(PAGED({ zoom: 3 }));
    // the zoom row keeps the menu open, so the nudge is one click away after the state change
    await click(button("Zoom in"));
    expect(last("browser_zoom")).toEqual({ project: "trantor", level: 3 });
  });

  it("the user agent submenu lists the contract's five and sends the pick", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    expect(text("User agent")?.textContent).toContain("Safari");
    await click(text("User agent"));
    for (const ua of USER_AGENTS) expect(text(ua)).not.toBeNull();
    expect(text("Chrome")?.getAttribute("aria-checked")).toBe("false");
    await click(text("Chrome"));
    expect(last("browser_set_user_agent")).toEqual({ project: "trantor", preset: "Chrome" });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("marks the current user agent, and find and device emulation open their controls", async () => {
    await sendState(PAGED({ user_agent: "Firefox" }));
    await mount();
    await openMore();
    await click(text("User agent"));
    expect(text("Firefox")?.getAttribute("aria-checked")).toBe("true");
    await press(document, "Escape");
    await openMore();
    await click(text("Find in page"));
    expect(host.querySelector('input[aria-label="Find in page"]')).not.toBeNull();
    await press(document, "Escape");
    await openMore();
    await click(text("Device emulation"));
    expect(host.textContent).toContain("size and user agent only");
  });

  it("history, favorites and site permissions open the panel on their tab", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    await click(text("History"));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.textContent).toContain("History");
    await openMore();
    await click(text("Favorites"));
    expect(host.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.textContent).toContain("Favorites");
    await openMore();
    await click(text("Site permissions"));
    expect(host.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.textContent).toContain("Site permissions");
  });

  it("adds the open page to favorites, and explains when nothing is open", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    await click(text("Add this page to favorites"));
    expect(last("browser_favorite_toggle")).toEqual({ project: "trantor", url: "http://localhost:5173/tree/popovic", title: "Popović line" });
    await sendState(state({}));
    await openMore();
    expect(text("Add this page to favorites")?.hasAttribute("disabled")).toBe(true);
  });

  it("clear browsing data asks first, then clears; Keep keeps", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    await click(text("Clear browsing data"));
    expect(sent("browser_clear_storage")).toHaveLength(0);
    expect(host.textContent).toContain("Sign this project's browser out of everything?");
    await click(text("Clear"));
    expect(last("browser_clear_storage")).toEqual({ project: "trantor" });
    await openMore();
    await click(text("Clear browsing data"));
    await click(text("Keep"));
    expect(sent("browser_clear_storage")).toHaveLength(1);
  });

  it("keeps the chat actions inert until B3 wires them, and opens the page externally", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    await click(text("Screenshot to chat"));
    await openMore();
    await click(text("Pick an element for chat"));
    // the mount's commands and nothing more: repeated set_visible runs come from the read settling
    const names = [...new Set(ipc.filter(c => c.command.startsWith("plugin:opener") || c.command.startsWith("browser_")).map(c => c.command))];
    expect(names).toEqual(["browser_state", "browser_set_visible", "browser_open", "browser_set_rect"]);
    await openMore();
    await click(text("Open in your default browser"));
    expect(last("plugin:opener|open_url")).toMatchObject({ url: "http://localhost:5173/tree/popovic" });
  });

  it("hides Browser settings until Settings grows a Browser section, and closes on outside click and Esc", async () => {
    await sendState(PAGED());
    await mount();
    await openMore();
    expect(text("Browser settings")).toBeNull();
    await act(async () => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await openMore();
    await click(button("More"));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await openMore();
    await press(document, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("the find bar (artboard F3)", () => {
  const findInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Find in page"]');

  it("opens on Cmd+F, steps through matches on Enter, and reports found or not", async () => {
    await sendState(PAGED());
    await mount();
    await chord("f");
    expect(findInput()).not.toBeNull();
    await typeInto(findInput(), "descendants");
    await press(findInput(), "Enter");
    expect(last("browser_find")).toEqual({ project: "trantor", text: "descendants", backwards: false });
    expect(host.textContent).toContain("match found");
    findFound = false;
    await press(findInput(), "Enter");
    expect(host.textContent).toContain("no match");
  });

  it("Shift+Enter and the arrows step backwards, and Enter on empty text sends nothing", async () => {
    await sendState(PAGED());
    await mount();
    await chord("f");
    await press(findInput(), "Enter");
    expect(sent("browser_find")).toHaveLength(0);
    await typeInto(findInput(), "line");
    await press(findInput(), "Enter", true);
    expect(last("browser_find")).toEqual({ project: "trantor", text: "line", backwards: true });
    await click(button("Previous match"));
    expect(last("browser_find")).toEqual({ project: "trantor", text: "line", backwards: true });
    await click(button("Next match"));
    expect(last("browser_find")).toEqual({ project: "trantor", text: "line", backwards: false });
  });

  it("Esc closes the find bar, clears the find, and restores the page only after", async () => {
    await sendState(PAGED());
    await mount();
    await click(button("Maximize the browser"));
    await chord("f");
    await typeInto(findInput(), "line");
    await press(findInput(), "Enter");
    await press(document, "Escape");
    expect(findInput()).toBeNull();
    expect(last("browser_find_clear")).toEqual({ project: "trantor" });
    expect(button("Restore")).not.toBeNull();
    await press(document, "Escape");
    expect(button("Maximize the browser")).not.toBeNull();
  });

  it("the close button closes too", async () => {
    await sendState(PAGED());
    await mount();
    await chord("f");
    await click(button("Close find"));
    expect(findInput()).toBeNull();
    expect(last("browser_find_clear")).toEqual({ project: "trantor" });
  });
});

describe("the device bar and the letterbox (artboard F2)", () => {
  const widthInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Device width"]');
  const heightInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Device height"]');

  const openDevices = async () => { await click(button("Devices")); };

  it("offers the contract's presets and emulates the pick", async () => {
    await sendState(PAGED());
    await mount();
    await openDevices();
    for (const p of DEVICE_PRESETS) expect(text(p.name)).not.toBeNull();
    await click(text("iPhone 15"));
    expect(last("browser_emulate")).toEqual({ project: "trantor", device: IPHONE });
  });

  it("seeds the size fields from the live emulation and applies a custom size on Enter", async () => {
    await sendState(PAGED({ emulation: IPHONE }));
    await mount();
    await openDevices();
    expect(widthInput()?.value).toBe("393");
    expect(heightInput()?.value).toBe("852");
    await typeInto(widthInput(), "500");
    await typeInto(heightInput(), "900");
    await press(widthInput(), "Enter");
    expect(last("browser_emulate")).toEqual({ project: "trantor", device: { name: "Custom", w: 500, h: 900, mobile: false } });
  });

  it("rotates the current size, and Done ends the emulation and folds the bar", async () => {
    await sendState(PAGED({ emulation: IPHONE }));
    await mount();
    await openDevices();
    await click(button("Rotate"));
    expect(last("browser_emulate")).toEqual({ project: "trantor", device: { name: "Custom", w: 852, h: 393, mobile: false } });
    expect(widthInput()?.value).toBe("852");
    await click(text("Done"));
    expect(last("browser_emulate")).toEqual({ project: "trantor", device: null });
    expect(text("Done")).toBeNull();
  });

  it("says size and user agent only, and the letterbox reads as the page's ground", async () => {
    await sendState(PAGED());
    await mount();
    expect(region()?.className).toContain("bg-[var(--v2-sunken)]");
    await openDevices();
    expect(host.textContent).toContain("size and user agent only");
    await sendState(PAGED({ emulation: IPHONE }));
    expect(region()?.className).toContain("bg-[var(--v2-chrome)]");
    await sendState(PAGED({ emulation: null }));
    expect(region()?.className).toContain("bg-[var(--v2-sunken)]");
  });
});

describe("the history, favorites and permissions panel (artboard F4)", () => {
  const openPanel = async (item: string) => { await click(button("More")); await click(text(item)); };

  it("lists history newest-first with host and age, and a row navigates", async () => {
    history = [
      { url: "http://localhost:5173/tree/popovic", title: "Popović line", at: NOW - 120 },
      { url: "https://github.com/tauri-apps/tauri", title: "tauri-apps/tauri", at: NOW - 7200 },
    ];
    await sendState(PAGED());
    await mount();
    await openPanel("History");
    expect(host.textContent).toContain("Popović line");
    expect(host.textContent).toContain("localhost:5173");
    expect(host.textContent).toContain("2m");
    expect(host.textContent).toContain("tauri-apps/tauri");
    expect(host.textContent).toContain("2h");
    await click(text("Popović line"));
    expect(last("browser_navigate")).toEqual({ project: "trantor", url: "http://localhost:5173/tree/popovic" });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("favorites navigate, and permissions revoke through the command", async () => {
    favorites = [{ url: "https://github.com/tauri-apps", title: "tauri-apps/tauri" }];
    permissions = [{ host: "accounts.google.com", rule: "site" }];
    await sendState(PAGED());
    await mount();
    await openPanel("Favorites");
    await click(text("tauri-apps/tauri"));
    expect(last("browser_navigate")).toEqual({ project: "trantor", url: "https://github.com/tauri-apps" });
    await openPanel("Site permissions");
    expect(host.textContent).toContain("accounts.google.com");
    expect(host.textContent).toContain("allowed for agents");
    await click(text("Revoke"));
    expect(last("browser_permission_revoke")).toEqual({ project: "trantor", host: "accounts.google.com" });
    expect(host.textContent).not.toContain("accounts.google.com");
  });

  it("switches tabs inside the panel and explains the empty lists", async () => {
    await sendState(PAGED());
    await mount();
    await openPanel("History");
    expect(host.textContent).toContain("No pages visited yet in this project.");
    await click(panelTab("Favorites"));
    expect(host.textContent).toContain("No favorite sites yet.");
    await click(panelTab("Site permissions"));
    expect(host.textContent).toContain("No site permissions yet.");
  });

  it("Esc and the close button close the panel", async () => {
    await sendState(PAGED());
    await mount();
    await openPanel("History");
    await press(document, "Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await openPanel("History");
    await click(button("Close panel"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("the Browser tab's chords (Cmd, only while the tab is mounted)", () => {
  it("new page, close page, favorite, find and devices", async () => {
    await sendState(PAGED());
    await mount();
    await chord("t");
    expect(last("browser_new_page")).toEqual({ project: "trantor", url: null });
    await chord("w");
    expect(last("browser_close_page")).toEqual({ project: "trantor", page: "p1" });
    await chord("d");
    expect(last("browser_favorite_toggle")).toEqual({ project: "trantor", url: "http://localhost:5173/tree/popovic", title: "Popović line" });
    await chord("f");
    expect(host.querySelector('input[aria-label="Find in page"]')).not.toBeNull();
    await press(document, "Escape");
    await chord("m", true);
    expect(host.textContent).toContain("size and user agent only");
    await chord("m", true);
    expect(host.textContent).not.toContain("size and user agent only");
  });

  it("ignores keys without Cmd and chords once the tab is gone", async () => {
    await sendState(PAGED());
    await mount();
    await press(document, "t");
    expect(sent("browser_new_page")).toHaveLength(0);
    await act(async () => { root.unmount(); });
    await chord("t");
    expect(sent("browser_new_page")).toHaveLength(0);
  });
});

describe("the wave-2 model", () => {
  it("clamps and labels zoom the way browser_zoom does", () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(clampZoom(0.25)).toBe(0.3);
    expect(clampZoom(4)).toBe(3);
    expect(zoomPercent(1.1)).toBe("110%");
    expect(zoomPercent(0.85)).toBe("85%");
  });

  it("names pages and rows by host, and blank pages say so", () => {
    expect(hostOf("https://github.com/tauri-apps/tauri")).toBe("github.com");
    expect(hostOf("http://localhost:5173/tree/popovic")).toBe("localhost:5173");
    expect(hostOf("localhost:5173")).toBe("localhost:5173");
    expect(pageLabel(page("p1", ""))).toBe("blank");
    expect(pageLabel(page("p1", "https://github.com"))).toBe("github.com");
  });

  it("reads history ages as words", () => {
    expect(ago(NOW - 5, NOW)).toBe("now");
    expect(ago(NOW - 120, NOW)).toBe("2m");
    expect(ago(NOW - 7200, NOW)).toBe("2h");
    expect(ago(NOW - 3 * 86400, NOW)).toBe("3d");
  });

  it("keeps the contract's device presets and user agents", () => {
    expect(DEVICE_PRESETS).toHaveLength(6);
    expect(DEVICE_PRESETS[0]).toEqual(IPHONE);
    expect(DEVICE_PRESETS[3]).toEqual({ name: "iPad", w: 820, h: 1180, mobile: true });
    expect(DEVICE_PRESETS[4]).toEqual({ name: "Laptop", w: 1280, h: 800, mobile: false });
    expect(DEVICE_PRESETS[5]).toEqual({ name: "Desktop", w: 1920, h: 1080, mobile: false });
    expect(USER_AGENTS).toEqual(["Safari", "Mobile Safari", "Chrome", "Chrome Android", "Firefox"]);
    expect(addressToUrl("github.com")).toBe("http://github.com");
  });
});
