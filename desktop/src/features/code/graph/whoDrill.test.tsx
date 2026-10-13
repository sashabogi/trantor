// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rebuildWorthy } from "./refresh";
import { GraphView } from "../GraphView";
import { SIX_NODE_GRAPH } from "./fixture";
import { graphViewState, resetGraphViewStates } from "./graphViewState";
import { agentColor, type Attribution, type AgentHistory } from "./attribution";
import type { GraphApi } from "./graphApi";

// SAFETY: React's act reads this flag from the test host.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const row = (agent: string, commits: number): AgentHistory => ({ agent, commits, lastAt: "2026-01-01T00:00:00Z", instances: [`${agent}-2`] });
const attribution: Attribution = {
  head: "fixture-head",
  files: [
    { path: "lib/a.ts", agents: [row("codex", 5), row("glm", 2)], dominant: "codex" },
    { path: "lib/b.ts", agents: [row("glm", 9)], dominant: "glm" },
    { path: "bin/cli.ts", agents: [row("unknown", 1)], dominant: "unknown" },
  ],
  agents: [{ agent: "glm", commits: 10 }, { agent: "codex", commits: 5 }, { agent: "unknown", commits: 1 }],
  coverage: { total: 16, rules: [] },
};
let host: HTMLDivElement;
let root: Root;
const api: GraphApi = { graph: async () => SIX_NODE_GRAPH, attribution: async () => attribution, changes: async () => [], fileChanges: () => () => {} };
const click = (element: Element | null) => {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a rendered button");
  act(() => element.click());
};
const tab = (text: string) => [...host.querySelectorAll('[role="tab"]')].find(el => el.textContent === text) ?? null;
const node = (id: string) => host.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
const mount = async (project = "p", graphApi = api) => { await act(async () => { root.render(<GraphView project={project} seat={null} api={graphApi} onOpen={() => {}} />); }); };

beforeEach(() => { resetGraphViewStates(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it("Who colors collapsed clusters and files, counts distinct commits, filters either layout and restores state", async () => {
  await mount();
  click(tab("Who"));
  expect(node("@dir:lib")?.style.borderLeftColor).toBe(agentColor("glm"));
  expect(node("@dir:lib")?.title).toContain("glm: 11 file changes");
  expect(host.querySelector('[data-who-agent="glm"]')?.textContent).toContain("10 commits");
  click(host.querySelector('[data-who-agent="glm"]'));
  expect(node("@dir:bin")?.dataset.graphTone).toBe("dim");
  expect(node("@dir:lib")?.dataset.graphTone).toBe("calm");
  click(node("@dir:lib"));
  expect(node("lib/a.ts")?.style.borderLeftColor).toBe(agentColor("codex"));
  expect(node("lib/a.ts")?.title).toContain("glm: 2 commits");
  expect(node("lib/a.ts")?.title).toContain("codex-2");
  expect(node("lib/stray.ts")?.dataset.graphTone).toBe("dim");
  click(tab("districts"));
  expect(node("lib/a.ts")?.title).toContain("codex: 5 commits");
  expect(node("bin/cli.ts")?.dataset.graphTone).toBe("dim");
  expect(host.querySelector('[data-district="lib"]')?.getAttribute("title")).toContain("glm: 11 file changes");
  expect(graphViewState("p")).toMatchObject({ lens: "who", agentFilter: "glm", layout: "districts" });
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(tab("Who")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[data-who-agent="glm"]')?.getAttribute("aria-pressed")).toBe("true");
  click(host.querySelector('[data-who-agent="glm"]'));
  expect(node("bin/cli.ts")?.dataset.graphTone).toBe("calm");
  act(() => root.unmount()); root = createRoot(host);
  await mount("other");
  expect(tab("Who")?.getAttribute("aria-selected")).toBe("false");
});

it("an attribution failure is visible while the file graph remains usable", async () => {
  await mount("p", { ...api, attribution: async () => { throw new Error("hub offline"); } });
  click(tab("Who"));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("hub offline");
  expect(node("@dir:lib")).not.toBeNull();
});

it("a slow attribution reply cannot overwrite a changed scope", async () => {
  let finish: (value: Attribution) => void = () => {};
  const slow = new Promise<Attribution>(resolve => { finish = resolve; });
  await mount("first", { ...api, attribution: () => slow });
  await mount("second", api);
  await act(async () => finish({ ...attribution, agents: [{ agent: "stale", commits: 99 }] }));
  click(tab("Who"));
  expect(host.querySelector('[data-who-agent="stale"]')).toBeNull();
  expect(host.querySelector('[data-who-agent="glm"]')).not.toBeNull();
});

it("attribution cache writes do not rebuild their own graph", () => {
  expect(rebuildWorthy([".trantor/cache/attribution.json"])).toBe(false);
  expect(rebuildWorthy([".trantor/cache/attribution.json", "lib/a.ts"])).toBe(true);
});

it("Who polls HEAD-backed history when a commit has no file-watcher event", async () => {
  vi.useFakeTimers();
  let calls = 0;
  await mount("p", { ...api, attribution: async () => {
    calls++;
    return { ...attribution, agents: [{ agent: "codex", commits: calls }] };
  } });
  expect(calls).toBe(1);
  click(tab("Who"));
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(host.querySelector('[data-who-agent="codex"]')?.textContent).toContain("2 commits");
  click(tab("clusters"));
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(calls).toBe(2);
});

it("Who does not overlap a slow history rebuild with its poll", async () => {
  vi.useFakeTimers();
  let finish: (value: Attribution) => void = () => {};
  const slow = new Promise<Attribution>(resolve => { finish = resolve; });
  let calls = 0;
  await mount("p", { ...api, attribution: () => { calls++; return slow; } });
  click(tab("Who"));
  await act(async () => { await vi.advanceTimersByTimeAsync(24_000); });
  expect(calls).toBe(1);
  await act(async () => finish(attribution));
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(calls).toBe(2);
});
