// @vitest-environment happy-dom
// #14271: a project with no orchestrator starts one from the chat panel, the rail and All projects, through the one shared wake.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { LocalSession, Peer } from "../../../shared/api/client";
import { PLAIN_WAKE_KICKOFF } from "../../../features/genesis/genesis";
import { useWakeStatus } from "../Projects/useWakeStatus";
import { Rail } from "../../shell/Rail";
import { AllProjects } from "../../shell/ClassicLenses";
import { liveOrchestratorProjects } from "../../shell/useShellData";
import { RightPanel } from "./RightPanel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let wakeCalls: unknown[];
let wakeAnswer: () => Promise<string>;
beforeEach(() => {
  wakeCalls = [];
  wakeAnswer = async () => "woken";
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(async (command, args) => {
    if (command === "project_wake") { wakeCalls.push(args); return wakeAnswer(); }
    if (command === "herdr_seats") return "[]";
    if (command === "plugin:event|listen") return 1;
    if (command === "sessions_list") return "[]";
    if (command === "handoff_states") return [];
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
  host.remove(); clearMocks(); vi.unstubAllGlobals();
});

const noListen = async () => () => {};
function Harness({ live }: { live: string[] }) {
  const w = useWakeStatus(invoke, noListen);
  const wake = { wakes: w.wakes, start: (p: string) => void w.retry(p) };
  return (
    <>
      <RightPanel project="alpha" seat={undefined} orchestrator={undefined} changed={0} onNavigate={() => {}} onClose={() => {}} wake={wake} />
      <Rail screen="workspace" project="alpha" live={live} unread={0} needsYou={0} update={null} onNavigate={() => {}} onWake={wake.start} />
      <AllProjects projects={["alpha", "beta"]} live={live} onNavigate={() => {}} onWake={wake.start} />
    </>
  );
}
const mount = async (live: string[] = []) => {
  await act(async () => { root.render(<Harness live={live} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const startButton = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Start orchestrator")) ?? null;
const hoverStarts = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Start "]')].map(b => b.getAttribute("aria-label"));

describe("chat panel empty state", () => {
  it("says no orchestrator runs and wakes the project once with the plain kickoff", async () => {
    await mount();
    expect(host.textContent).toContain("No orchestrator is running for this project.");
    expect(startButton()).not.toBeNull();
    await click(startButton());
    await click(startButton());
    expect(wakeCalls).toEqual([{ project: "alpha", kickoff: PLAIN_WAKE_KICKOFF }]);
  });

  it("shows Starting while the wake is in flight and ignores a second click", async () => {
    let release: (v: string) => void = () => {};
    wakeAnswer = () => new Promise<string>(r => { release = r; });
    await mount();
    await click(startButton());
    expect(host.textContent).toContain("Starting…");
    const busy = [...host.querySelectorAll("button")].find(b => b.textContent === "Starting…");
    expect(busy?.disabled).toBe(true);
    await click(busy ?? null);
    expect(wakeCalls).toHaveLength(1);
    await act(async () => { release("woken"); });
  });

  it("keeps a failure in plain words until the next click", async () => {
    wakeAnswer = async () => { throw new Error("herdr is not running"); };
    await mount();
    await click(startButton());
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(host.textContent).toContain("Could not open the orchestrator: herdr is not running");
    wakeAnswer = async () => "woken";
    await click(startButton());
    expect(wakeCalls).toHaveLength(2);
  });
});

describe("Start on a project row", () => {
  it("offers Start for projects without a live orchestrator and not for the live one", async () => {
    await mount(["beta"]);
    // The rail lists the active project alpha and live beta; All projects lists both again.
    expect(hoverStarts()).toEqual(["Start alpha", "Start alpha"]);
  });

  it("clicking a Start button wakes that project", async () => {
    await mount([]);
    await click(host.querySelector('nav button[aria-label="Start alpha"]'));
    expect(wakeCalls).toEqual([{ project: "alpha", kickoff: PLAIN_WAKE_KICKOFF }]);
  });
});

describe("what counts as a live orchestrator", () => {
  const open = (project: string, status: string | null): LocalSession => ({ project, status });
  const peer = (session: string, project: string, extra: Partial<Peer> = {}): Peer => ({ session, project, online: true, ...extra });

  it("counts a herdr-confirmed local pane and an online host session, nothing else", () => {
    const names = liveOrchestratorProjects(
      [open("a", "idle"), open("b", null)],
      [peer("MacBook-Pro:c", "c"), peer("codex-8:d", "d", { kind: "agent" }), peer("brief:e", "e", { kind: "tool" }), peer("MacBook-Pro:f", "f", { online: false })],
    );
    expect(names).toEqual(["a", "c"]);
  });
});
