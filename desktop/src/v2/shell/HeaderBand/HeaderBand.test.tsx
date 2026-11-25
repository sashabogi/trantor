// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type HubEvent } from "../../../shared/api/client";
import { HeaderBand } from "./index";
import { NeedsYou } from "./NeedsYou";
import { PhaseGoal } from "./PhaseGoal";
import { ProjectFrame } from "../ProjectFrame";
import { SeatLanes } from "./SeatLanes";
import { CiChip } from "./MainHealth";
import type { CiStatus } from "./useBandData";
import { hold, phase, proposal, turn } from "./testFixtures";

// SAFETY: #14256 enables React's documented test flag on this DOM fixture's global object.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let ci: CiStatus;
let proposals = [proposal(1), proposal(2, "other")];
let holds = [hold(1)];
let turns = [turn()];
let peers = [{ session: "codex-8:trantor", project: "trantor", online: true, status: "working · card" }];
let gitFails = false;
let calls: { command: string; args: unknown }[];
let listeners: ((event: HubEvent) => void)[];
let client: HubClient;
let paths: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(3_600_000);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  ci = { sha: "abcdef", tag: "app-v2", hasRemote: true, localCheckout: true, tagPublishedAt: "1970-01-01T00:00:00Z", ci: { state: "running", url: "https://github.com/test/actions/runs/1" } };
  proposals = [proposal(1), proposal(2, "other")]; holds = [hold(1)]; turns = [turn()];
  calls = []; listeners = []; paths = []; gitFails = false;
  peers = [{ session: "codex-8:trantor", project: "trantor", online: true, status: "working · card" }];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "ci_status") return JSON.stringify(ci);
    if (command === "git_panel" && gitFails) throw new Error("unavailable");
    if (command === "git_panel") return JSON.stringify({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, status: [], counts: [], log: [] });
    return null;
  });
  client = new HubClient("http://hub", async args => {
    paths.push(args.path);
    const path = args.path.split("?")[0];
    const body = path === "/phases" ? { brief: "Project", phases: [phase("P1", ["done", "todo"], "Build the band")] }
      : path === "/peers" ? { peers }
      : path === "/telemetry/turns" ? { rows: turns }
      : path === "/tasks" ? { tasks: [] } : path === "/proposals" ? { proposals } : { holds };
    return { status: 200, body: JSON.stringify(body) };
  });
  vi.spyOn(client, "streamEvents").mockImplementation(listener => { listeners.push(listener); return () => undefined; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("renders all four sources and navigates to Workspace, Board and Inbox", async () => {
  const navigate = vi.fn();
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={navigate} />); });
  expect(host.textContent).toContain("Phase goal · 1 of 2");
  expect(host.querySelector("[data-fraction]")?.getAttribute("data-fraction")).toBe("0.5");
  expect(host.textContent).toContain("main"); expect(host.textContent).toContain("↑2 ↓1");
  expect(host.textContent).toContain("app-v2");
  expect(host.querySelector('[aria-label="2 needs you, open Inbox"]')).not.toBeNull();
  expect(calls.find(call => call.command === "git_panel")?.args).toEqual({ project: "trantor", scope: "project" });
  expect(calls.find(call => call.command === "ci_status")?.args).toEqual({ project: "trantor" });
  expect(paths).toContain("/phases?project=trantor");
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label*="open Workspace"]')?.click();
    host.querySelector<HTMLButtonElement>('[aria-label^="Phase goal"]')?.click();
    host.querySelector<HTMLButtonElement>('[aria-label*="open Inbox"]')?.click();
  });
  expect(navigate.mock.calls).toEqual([["workspace", "trantor"], ["board", "trantor"], ["inbox", "trantor"]]);
});

it("grows working bars every five seconds and polls turns every thirty seconds", async () => {
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  const width = () => parseFloat(host.querySelector<HTMLElement>("[data-running-bar]")?.style.width ?? "0");
  const initial = width();
  expect(initial).toBeCloseTo(600_000 / 3_600_000 * 100);
  await advance(5_000);
  expect(width()).toBeGreaterThan(initial);
  expect(paths.filter(path => path.startsWith("/telemetry/turns"))).toHaveLength(1);
  await advance(25_000);
  const polls = paths.filter(path => path.startsWith("/telemetry/turns"));
  expect(polls).toHaveLength(2);
  expect(polls[0]).toContain("since=0"); expect(polls[1]).toContain("since=30000");
  expect(host.querySelector('[title="Card #14256 · 600s · completed"]')).not.toBeNull();
});

it("starts an observed working bar when a seat has no completed turns", async () => {
  turns = [];
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  await advance(5_000);
  expect(parseFloat(host.querySelector<HTMLElement>("[data-running-bar]")?.style.width ?? "0")).toBeGreaterThan(0);
});

it("changes CI polling from one minute while running to five minutes when settled", async () => {
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  ci = { ...ci, ci: { state: "green", url: ci.ci?.url } };
  await advance(60_000);
  expect(calls.filter(call => call.command === "ci_status")).toHaveLength(2);
  expect(host.querySelector('[aria-label="CI passed"]')).not.toBeNull();
  await advance(299_000);
  expect(calls.filter(call => call.command === "ci_status")).toHaveLength(2);
  await advance(1_000);
  expect(calls.filter(call => call.command === "ci_status")).toHaveLength(3);
});

it("shows the running, green, red and unavailable CI states and opens the run URL", async () => {
  await act(async () => { root.render(<CiChip status={ci} />); });
  expect(host.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
  await act(async () => { host.querySelector("button")?.click(); });
  expect(calls.find(call => call.command === "plugin:opener|open_url")?.args).toMatchObject({ url: ci.ci?.url });
  await act(async () => { root.render(<CiChip status={{ ...ci, ci: { state: "green" } }} />); });
  expect(host.querySelector('[aria-label="CI passed"]')).not.toBeNull();
  expect(host.querySelector(".motion-safe\\:animate-spin")).toBeNull();
  await act(async () => { root.render(<CiChip status={{ ...ci, ci: { state: "red", failing: "Lint" } }} />); });
  expect(host.textContent).toContain("Lint"); expect(host.querySelector('[data-tone="bad"]')).not.toBeNull();
  await act(async () => { root.render(<CiChip status={{ ...ci, ci: null }} />); });
  expect(host.querySelector('[aria-label="CI unavailable"]')?.hasAttribute("disabled")).toBe(true);
});

it("pulses once on a rise with a new id, never on repeat polls, decreases or seen ids", async () => {
  const render = (ids: string[]) => act(async () => { root.render(<NeedsYou ids={ids} onOpen={vi.fn()} />); });
  const pulse = () => host.querySelector("[data-pulse]")?.getAttribute("data-pulse");
  await render([]); expect(pulse()).toBe("0"); expect(host.querySelector("button")?.className).toContain("border-dashed");
  await render(["proposal:1"]); expect(pulse()).toBe("1");
  const pulsedNode = host.querySelector("[data-pulse]");
  await render(["proposal:1"]); expect(host.querySelector("[data-pulse]")).toBe(pulsedNode);
  await render([]); expect(pulse()).toBe("1");
  await render(["proposal:1"]); expect(pulse()).toBe("1");
  await render(["proposal:1", "hold:1"]); expect(pulse()).toBe("2");
  await render(["proposal:2", "hold:1"]); expect(pulse()).toBe("2");
  await advance(60_000); expect(pulse()).toBe("2");
});

it("refreshes project decisions through the existing pending hooks", async () => {
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  proposals = [...proposals, proposal(3)]; holds = [...holds, hold(2, "other")];
  await advance(60_000);
  expect(host.querySelector('[aria-label="3 needs you, open Inbox"]')).not.toBeNull();
  expect(listeners).toHaveLength(3);
});

it("hides phases without cards and lists at most three open titles on hover", async () => {
  await act(async () => { root.render(<PhaseGoal data={{ brief: "", phases: [] }} onOpen={vi.fn()} />); });
  expect(host.textContent).toBe("");
  await act(async () => { root.render(<PhaseGoal data={{ brief: "", phases: [phase("P1", ["todo", "todo", "todo", "todo"])] }} onOpen={vi.fn()} />); });
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("Card 2");
  expect(host.querySelector('[role="tooltip"]')?.textContent).not.toContain("Card 3");
});

it.each([["done"], ["done", "done"], ["done", "todo"], ["todo"]])("draws the ring for statuses %j", async (...statuses: string[]) => {
  await act(async () => { root.render(<PhaseGoal data={{ brief: "", phases: [phase("live", statuses)] }} onOpen={vi.fn()} />); });
  const arc = host.querySelector("circle[data-fraction]");
  const circumference = 2 * Math.PI * 14;
  const fraction = statuses.filter(s => s === "done").length / statuses.length;
  expect(arc?.getAttribute("stroke-dasharray")).toBe(`${circumference} ${circumference}`);
  expect(Number(arc?.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * (1 - fraction));
});

it("grows the orchestrator bar from its working transition and shows its idle track", async () => {
  turns = [];
  peers = [{ session: "MacBook:trantor", project: "trantor", online: true, status: "idle" }];
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  expect(host.textContent).toContain("No turns in the last hour");
  peers = [{ ...peers[0], status: "working" }];
  await advance(15_000);
  expect(host.querySelector('[aria-label="orchestrator, working, open Workspace"]')).not.toBeNull();
  await advance(5_000);
  const bar = host.querySelector<HTMLElement>("[data-running-bar]");
  expect(parseFloat(bar?.style.width ?? "0")).toBeCloseTo(5_000 / 3_600_000 * 100);
  turns = [turn()]; peers = [{ ...peers[0], status: "idle" }];
  await advance(10_000);
  expect(host.querySelector('[aria-label="orchestrator, idle, open Workspace"]')).not.toBeNull();
  expect(host.querySelector('[data-running-bar]')).toBeNull();
});

it("shows a quiet line for idle seats and expired turns, with no empty tracks", async () => {
  await act(async () => { root.render(<SeatLanes project="trantor" peers={[{ session: "a:trantor", online: true, status: "idle" }]}
    turns={[turn({ ts: 0 })]} now={3_600_000} workingSince={{}} onOpen={vi.fn()} />); });
  expect(host.textContent).toBe("No turns in the last hour");
  expect(host.querySelector("button")).toBeNull();
});

it("limits four active seats to three lanes with room for every label", async () => {
  const seats = ["a", "b", "c", "d"].map(name => ({ session: `${name}:trantor`, online: true, status: "working" }));
  await act(async () => { root.render(<SeatLanes project="trantor" peers={seats} turns={[]} now={3_600_000} workingSince={{}} onOpen={vi.fn()} />); });
  const lanes = [...host.querySelectorAll("button")];
  expect(lanes).toHaveLength(3);
  for (const lane of lanes) expect(lane.className).toContain("min-h-4");
});

it("shows release age and hides both remote facts when no remote exists", async () => {
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  expect(host.textContent).toContain("released app-v2 · 1h ago");
  ci = { ...ci, hasRemote: false, ci: null };
  await advance(60_000);
  expect(host.textContent).not.toContain("app-v2");
  expect(host.querySelector('[aria-label^="CI"]')).toBeNull();
});

it("shows no local checkout after git fails instead of reading forever", async () => {
  gitFails = true;
  ci = { ...ci, localCheckout: false, hasRemote: false, sha: null, tag: null, ci: null };
  await act(async () => { root.render(<HeaderBand client={client} project="trantor" onNavigate={vi.fn()} />); });
  expect(host.textContent).toContain("No local checkout");
  expect(host.textContent).not.toContain("Reading git");
  expect(host.querySelector('[aria-label^="CI"]')).toBeNull();
});

it("mounts a single line band with only lanes and CI to the right of developer lens tabs", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "developer", setItem: () => undefined });
  const navigate = vi.fn();
  await act(async () => { root.render(<ProjectFrame client={client} project="trantor" lens="code" onNavigate={navigate}><div>Editor</div></ProjectFrame>); });
  const tabs = host.querySelector('[role="tablist"]');
  const band = tabs?.querySelector('[aria-label="Project overview"]');
  expect(band).not.toBeNull();
  expect(host.querySelectorAll('[aria-label="Project overview"]')).toHaveLength(1);
  expect(band?.querySelector('[aria-label="CI running"]')).not.toBeNull();
  expect(band?.querySelector('[aria-label*="open Workspace"]')).not.toBeNull();
  expect(band?.querySelector('[aria-label="Seat activity, last 60 minutes"]')?.className).not.toContain("flex-col");
  expect(band?.textContent).not.toMatch(/Phase goal|needs you|released/);
  await act(async () => { band?.querySelector<HTMLButtonElement>('[aria-label*="open Workspace"]')?.click(); });
  expect(navigate).toHaveBeenCalledWith("workspace", "trantor");
});

it("draws a visible, hoverable bar for a short failed turn and a 10 minute bar for a turnless working peer", async () => {
  const orchestrator = [{ session: "MacBook-Pro-M1:trantor", online: true, status: "working" }];
  await act(async () => { root.render(<SeatLanes project="trantor" peers={orchestrator} workingSince={{}} onOpen={vi.fn()} now={3_600_000}
    turns={[turn({ persona: "orchestrator", ts: 3_500_000, duration_ms: 4_000, effExit: 1, outcome: "failed" })]} />); });
  const mark = host.querySelector<HTMLElement>("[title^='Card']");
  expect(mark?.style.minWidth).toBe("3px");
  expect(mark?.querySelector("[data-turn-hit]")?.className).toContain("w-2");
  await act(async () => { root.render(<SeatLanes project="trantor" peers={orchestrator} turns={[]} now={3_600_000} workingSince={{}} onOpen={vi.fn()} />); });
  expect(parseFloat(host.querySelector<HTMLElement>("[data-running-bar]")?.style.width ?? "0")).toBeCloseTo(600_000 / 3_600_000 * 100);
});
