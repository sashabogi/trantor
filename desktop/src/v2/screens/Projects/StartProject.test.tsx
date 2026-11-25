// @vitest-environment happy-dom
// #13984: Start a project from the 2.0 shell. The real ShellV2 and the real GenesisSheet run; the
// sheet's Tauri calls arrive through its deps seam, the shell's own through mockIPC.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { ShellV2 } from "../../ShellV2";
import type { WakeProgress } from "../../../features/genesis/wakeProgress";
import { PLAIN_WAKE_KICKOFF } from "../../../features/genesis/genesis";
import { WAKE_DEADLINE_MS } from "./wakeModel";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY = JSON.stringify({ peers: [], messages: [], cursor: 0, tasks: [], proposals: [], holds: [], entries: [], machines: [], ts: Date.now(), staleAfterMs: 90_000 });

let host: HTMLDivElement;
let root: Root;
let known: string[];
let calls: { cmd: string; args: InvokeArgs }[];
let wakeAnswer: (args: InvokeArgs) => Promise<string>;
let emitWake: (p: WakeProgress) => void;

// One answer per command, typed as the Promise<T> the sheet awaits; the cast is the whole fake.
const answer = <T,>(value: string): Promise<T> =>
  // SAFETY: every caller of the fake asks for exactly the shape the real command returns.
  Promise.resolve(value as T);

const fakeInvoke = <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
  calls.push({ cmd, args: args ?? {} });
  if (cmd === "project_dev_root") return answer<T>("/Users/s/development");
  if (cmd === "project_new") {
    // SAFETY: the sheet sends {args: {name}}; the fake echoes the asked name like `trantor new --json`.
    const name = (args as { args: { name: string } }).args.name;
    return answer<T>(JSON.stringify({ name, dir: `/tmp/${name}`, branch: "main", hub: "http://h", card: null }));
  }
  if (cmd === "project_wake") return wakeAnswer(args ?? {}).then(line => answer<T>(line));
  return answer<T>("{}");
};

beforeEach(() => {
  calls = [];
  known = ["crebral-cortex", "trantor"];
  wakeAnswer = () => Promise.resolve("project awake in pane w1:p1");
  emitWake = () => {};
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "known_projects") return known;
    if (command === "hub_for_project") return "http://127.0.0.1:4477";
    if (command === "identity_name") return "sasha";
    if (command === "handoff_states") return [];
    if (command === "local_sessions") return [];
    if (command === "orch_restorables") return [];
    if (command === "hub_request") return { status: 200, body: EMPTY };
    return null;
  }, { shouldMockEvents: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  // Chat's unlisten settles after unmount; the event mock must outlive it.
  await act(async () => { await Promise.resolve(); });
  host.remove(); clearMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const mount = () => act(async () => {
  root.render(<ShellV2 startDeps={{
    genesis: { invoke: fakeInvoke, listenDrops: async () => () => {} },
    listenWake: async handler => { emitWake = handler; return () => {}; },
  }} />);
});
const click = (el: HTMLElement | null) => act(async () => { el?.click(); });
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const need = (sel: string): HTMLElement => {
  const found = q(sel);
  if (!found) throw new Error(`missing ${sel}`);
  return found;
};
const byText = (sel: string, text: string) => [...host.querySelectorAll<HTMLElement>(sel)].find(e => e.textContent?.includes(text)) ?? null;
const dialog = () => document.querySelector('[role="dialog"]');
const key = (target: Element, init: KeyboardEventInit) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const status = () => q('[role="status"][aria-label$="start status"]')?.textContent ?? "";

async function createProject(name: string) {
  await click(byText('[role="menuitem"]', "Start a project") ?? q('button[aria-label="Start a project"]'));
  const input = dialog()?.querySelector<HTMLInputElement>('input[placeholder="New Client Portal"]');
  await act(async () => {
    // SAFETY: the native setter is how a test types into a React-controlled input.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { dialog()?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("Start a project in the 2.0 shell", () => {
  it("opens the same sheet from the top bar switcher", async () => {
    await mount();
    await click(q('button[title="Switch project"]'));
    const first = q('[role="menu"][aria-label="Projects"] [role="menuitem"]');
    expect(first?.textContent).toContain("Start a project");
    await click(first);
    expect(dialog()?.textContent).toContain("Create & wake");
    expect(calls.some(c => c.cmd === "project_dev_root")).toBe(true);
  });

  it("opens it from the All projects screen and from the dashboard sidebar plus", async () => {
    await mount();
    await click(q('nav button[aria-label="All projects"]'));
    await click(byText("main button", "Start a project"));
    expect(dialog()).not.toBeNull();
    await key(need('[role="dialog"]'), { key: "Escape" });
    expect(dialog()).toBeNull();
    await click(q('nav button[aria-label="Dashboard"]'));
    await click(q('aside[aria-label="Projects"] button[aria-label="Start a project"]'));
    expect(dialog()).not.toBeNull();
  });

  it("opens it on cmd+N from the shell, but never from an input or the terminal", async () => {
    await mount();
    const filter = need("#v2-dash-filter");
    await key(filter, { key: "n", metaKey: true });
    expect(dialog()).toBeNull();
    const term = document.createElement("div");
    term.className = "xterm";
    host.append(term);
    await key(term, { key: "n", metaKey: true });
    expect(dialog()).toBeNull();
    await key(need("main"), { key: "n", metaKey: true });
    expect(dialog()).not.toBeNull();
  });

  it("keeps Tab inside the sheet and closes on Escape", async () => {
    await mount();
    await key(need("main"), { key: "n", metaKey: true });
    const fields = [...(dialog()?.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea") ?? [])];
    fields[fields.length - 1]?.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { document.activeElement?.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fields[0]);
    await key(document.activeElement ?? document.body, { key: "Escape" });
    expect(dialog()).toBeNull();
  });

  it("lists the new project, makes it active and shows its Workspace", async () => {
    await mount();
    await createProject("fresh-one");
    expect(dialog()).toBeNull();
    expect(q("header")?.textContent).toContain("fresh-one");
    expect(q("main")?.getAttribute("data-screen")).toBe("workspace");
    expect(q("h1")?.textContent).toBe("fresh-one");
    await click(q('button[title="Switch project"]'));
    expect(byText('[role="menu"] [role="menuitem"]', "fresh-one")).not.toBeNull();
    expect(calls.filter(c => c.cmd === "project_wake")).toHaveLength(1);
  });

  it("says the wake as it happens and settles on its outcome", async () => {
    let finish: (line: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(resolve => { finish = resolve; });
    await mount();
    await createProject("fresh-one");
    expect(status()).toContain("Opening the orchestrator…");
    expect(host.querySelector('[aria-live="polite"]')).toBeNull();
    await act(async () => { emitWake({ project: "fresh-one", phase: "waiting_idle", detail: null }); });
    expect(status()).toContain("Waiting for it to take its first prompt");
    await act(async () => { emitWake({ project: "fresh-one", phase: "kickoff_landed", detail: "prompt delivered" }); finish("kickoff sent into idle pane w1:p1"); });
    expect(status()).toContain("First prompt delivered");
  });

  it("keeps following the detached kickoff after the early awake answer", async () => {
    let finish: (line: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(resolve => { finish = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    await createProject("fresh-one");
    await act(async () => { emitWake({ project: "fresh-one", phase: "opened", detail: null }); });
    await act(async () => { finish("project awake in pane w20:p1 · kickoff running in the background"); });
    await act(async () => { emitWake({ project: "fresh-one", phase: "waiting_idle", detail: null }); });
    await act(async () => { emitWake({ project: "fresh-one", phase: "kickoff_sent", detail: null }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(87_000); });
    await act(async () => {
      emitWake({ project: "fresh-one", phase: "kickoff_landed", detail: "kickoff prompt delivered — successor is recapping · 1 attempt(s), 87s" });
      emitWake({ project: "fresh-one", phase: "ended", detail: null });
    });
    expect(status()).toContain("First prompt delivered to the orchestrator.");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(status()).toContain("First prompt delivered to the orchestrator.");
    await click(q('button[aria-label="Dismiss wake status"]'));
    expect(status()).not.toContain("First prompt delivered");
  });

  it("does not let a late awake answer rewind kickoff progress", async () => {
    let finish: (line: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(resolve => { finish = resolve; });
    await mount();
    await createProject("fresh-one");
    await act(async () => { emitWake({ project: "fresh-one", phase: "kickoff_sent", detail: null }); });
    expect(status()).toContain("First prompt sent. Waiting on the session…");
    await act(async () => { finish("project awake in pane w1:p1 · kickoff running in the background"); });
    expect(status()).toContain("First prompt sent. Waiting on the session…");
    expect(status()).not.toContain("Waiting for it to take its first prompt");
  });

  it("does not let a late awake answer replace a delivered outcome", async () => {
    let finish: (line: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(resolve => { finish = resolve; });
    await mount();
    await createProject("fresh-one");
    await act(async () => { emitWake({ project: "fresh-one", phase: "kickoff_landed", detail: "kickoff prompt delivered" }); });
    expect(status()).toContain("First prompt delivered to the orchestrator.");
    await act(async () => { finish("project awake in pane w1:p1 · kickoff running in the background"); });
    expect(status()).toContain("First prompt delivered to the orchestrator.");
  });

  it("counts elapsed seconds across the opening and kickoff phases", async () => {
    let finish: (line: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(resolve => { finish = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    await mount();
    await createProject("fresh-one");
    expect(status()).toContain("Opening the orchestrator… · 0s");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status()).toContain("Opening the orchestrator… · 2s");
    await act(async () => { finish("project awake in pane w1:p1 · kickoff running in the background"); });
    expect(status()).toContain("Waiting for it to take its first prompt… · 2s");
    await act(async () => { emitWake({ project: "fresh-one", phase: "kickoff_sent", detail: null }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(status()).toContain("First prompt sent. Waiting on the session… · 3s");
  });

  it("keeps elapsed time when switching away from a waking project and back", async () => {
    wakeAnswer = () => new Promise<string>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    await mount();
    await createProject("fresh-one");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status()).toContain("Opening the orchestrator… · 2s");
    await click(q('button[title="Switch project"]'));
    await click(byText('[role="menu"] [role="menuitem"]', "trantor"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await click(q('button[title="Switch project"]'));
    await click(byText('[role="menu"] [role="menuitem"]', "fresh-one"));
    expect(status()).toContain("Opening the orchestrator… · 5s");
  });

  it("shows a failed wake with its reason and Try again calls the same wake", async () => {
    wakeAnswer = () => Promise.reject(new Error("herdr is not installed"));
    await mount();
    await createProject("fresh-one");
    expect(status()).toContain("Could not open the orchestrator: herdr is not installed");
    wakeAnswer = () => Promise.resolve("project awake in pane w1:p1 · ok");
    await click(byText('[role="status"] button', "Try again"));
    const wakes = calls.filter(c => c.cmd === "project_wake");
    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.args).toEqual({ project: "fresh-one", kickoff: PLAIN_WAKE_KICKOFF });
    expect(status()).toContain("Waiting for it to take its first prompt");
    expect(byText('[role="status"] button', "Try again")).toBeNull();
  });

  it("ends a wake that never answers in words, with Try again", async () => {
    wakeAnswer = () => new Promise<string>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    await createProject("fresh-one");
    expect(status()).toContain("Opening the orchestrator…");
    await act(async () => { await vi.advanceTimersByTimeAsync(WAKE_DEADLINE_MS + 1); });
    expect(status()).toContain("No answer from the orchestrator after 3 minutes 20 seconds");
    expect(byText('[role="status"] button', "Try again")).not.toBeNull();
  });

  it("does not offer a Plan first checkbox or assume the session's starting mode", async () => {
    await mount();
    await click(q('button[title="Switch project"]'));
    await click(byText('[role="menuitem"]', "Start a project"));
    expect(dialog()?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog()?.textContent).not.toMatch(/plan first/i);
    await key(need('[role="dialog"]'), { key: "Escape" });
    await createProject("fresh-one");
    expect(status()).toContain("Read or switch the session mode from the composer's first chip.");
    expect(status()).not.toContain("Opened in Agent mode");
    expect(calls.some(c => c.cmd === "pane_mode_set")).toBe(false);
    await click(q('button[aria-label="Dismiss this note"]'));
    expect(status()).not.toContain("session mode");
  });

  it("shows one centred Start a project card when there are no projects", async () => {
    known = [];
    await mount();
    const card = q('section[aria-label="Start a project"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Blank");
    expect(card?.textContent).toContain("From a brief");
    expect(q('aside[aria-label="Projects"]')).toBeNull();
    await click(card?.querySelector("button") ?? null);
    expect(dialog()).not.toBeNull();
  });
});
