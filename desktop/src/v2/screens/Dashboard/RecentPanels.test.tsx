// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubClient, type Handoff, type LessonRec } from "../../../shared/api/client";
import { RecentPanels } from "./RecentPanels";

// SAFETY: React's test-only flag enables act warnings in this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const now = Date.now();
const navigate = vi.fn();
const calls: string[] = [];
let handoffs: Handoff[];
let globalLessons: LessonRec[];
let agentLessons: LessonRec[];
const client = new HubClient("http://hub.test", async ({ path }) => {
  calls.push(path);
  const url = new URL(path, "http://hub.test");
  const body = url.pathname === "/handoffs"
    ? { handoffs: handoffs.filter(h => h.project === url.searchParams.get("project")) }
    : { lessons: { global: globalLessons, byAgent: { codex: agentLessons } } };
  return { status: 200, body: JSON.stringify(body) };
});
beforeEach(() => {
  calls.length = 0;
  handoffs = [];
  globalLessons = [];
  agentLessons = [];
  navigate.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const mount = async (projects = ["trantor", "other local"]) => {
  await act(async () => { root.render(<RecentPanels client={client} projects={projects} onNavigate={navigate} />); });
};
const panels = () => host.querySelectorAll("section");

it("shows the newest five local handoffs with summary and time, and opens their Workspace", async () => {
  handoffs = Array.from({ length: 7 }, (_, i) => ({
    project: i % 2 ? "other local" : "trantor", session: `seat-${i}`, ts: now - (8 - i) * 60_000,
    trigger: "context limit",
  }));
  handoffs.push({ project: "remote", session: "remote-seat", ts: now });
  await mount();
  expect(calls).toContain("/handoffs?project=trantor");
  expect(calls).toContain("/handoffs?project=other%20local");
  const rows = [...panels()[0].querySelectorAll("button")];
  expect(rows).toHaveLength(5);
  expect(rows.map(r => r.textContent?.match(/seat-\d/)?.[0])).toEqual(["seat-6", "seat-5", "seat-4", "seat-3", "seat-2"]);
  expect(rows[0].textContent).toContain("trantor");
  expect(rows[0].textContent).toContain("2m ago");
  expect(rows[0].textContent).toContain("seat-6 · context limit");
  expect(host.textContent).not.toContain("remote-seat");
  await act(async () => { rows[1].click(); });
  expect(navigate).toHaveBeenCalledWith("workspace", "other local");
});

it("merges global and agent lessons into the latest five with scope and time", async () => {
  globalLessons = Array.from({ length: 4 }, (_, i) => ({ text: `Global ${i}`, scope: "global", by: "seat", ts: now - (8 - i) * 60_000 }));
  agentLessons = Array.from({ length: 3 }, (_, i) => ({ text: `Agent ${i}`, scope: "codex", by: "seat", ts: now - (4 - i) * 60_000 }));
  await mount();
  expect(calls).toContain("/learning");
  expect([...panels()[1].querySelectorAll("p")].map(p => p.textContent)).toEqual(["Agent 2", "Agent 1", "Agent 0", "Global 3", "Global 2"]);
  expect(panels()[1].textContent).toContain("codex");
  expect(panels()[1].textContent).toContain("global");
  expect(panels()[1].textContent).toContain("2m ago");
});

it("shows a quiet empty line for each panel", async () => {
  await mount();
  expect(panels()[0].querySelector("p")?.textContent).toBe("No handoffs yet.");
  expect(panels()[1].querySelector("p")?.textContent).toBe("No lessons yet.");
  expect(host.querySelector("button")).toBeNull();
});

it("does not request all-machine handoffs when there are no local projects", async () => {
  await mount([]);
  expect(calls).toEqual(["/learning"]);
  expect(panels()[0].textContent).toContain("No handoffs yet.");
});

it("refreshes both panels and clears its polling timer on unmount", async () => {
  vi.useFakeTimers();
  await mount();
  handoffs = [{ project: "trantor", session: "fresh", ts: now }];
  globalLessons = [{ text: "Fresh lesson", scope: "global", by: "seat", ts: now }];
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(panels()[0].textContent).toContain("fresh");
  expect(panels()[1].textContent).toContain("Fresh lesson");
  expect(panels()[0].textContent).not.toContain("fresh ·");
  await act(async () => { root.render(null); });
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toHaveLength(count);
});
