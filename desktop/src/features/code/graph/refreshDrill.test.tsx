// @vitest-environment happy-dom
// The #7953 app drills in drill-surface form (the real watcher has no host under happy-dom, so
// the batches are pushed by hand and the quiet second is a fake clock). Before-counts are read
// first as the positive control; a PASS line carries the evidence.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../GraphView";
import { QUIET_MS } from "./refresh";
import type { CodeGraph, CodeGraphResponse, GraphApi } from "./graphApi";
import { SIX_NODE_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/** The fixture after `import "./x"` lands in lib/a.ts and lib/x.ts is created. */
const withX = (base: CodeGraph): CodeGraph => ({
  ...base,
  nodes: [
    ...base.nodes.map(n => (n.id === "lib/a.ts" ? { ...n, outDegree: n.outDegree + 1 } : n)),
    { ...base.nodes[0], id: "lib/x.ts", name: "x.ts", inDegree: 1, outDegree: 0, testedBy: 0, cycleId: null },
  ],
  edges: [...base.edges, { source: "lib/a.ts", target: "lib/x.ts", relation: "imports" }],
  meta: { ...base.meta, files: base.meta.files + 1, edges: base.meta.edges + 1 },
});

/** A seat worktree holding an uncommitted lib/new.ts the project checkout does not have. */
const SEAT_GRAPH: CodeGraph = {
  ...SIX_NODE_GRAPH,
  root: "/worktrees/p/kimi",
  nodes: [...SIX_NODE_GRAPH.nodes, { ...SIX_NODE_GRAPH.nodes[2], id: "lib/new.ts", name: "new.ts" }],
  meta: { ...SIX_NODE_GRAPH.meta, files: 7 },
};

type Harness = {
  api: GraphApi;
  graph: ReturnType<typeof vi.fn<(project: string, seat?: string) => Promise<CodeGraphResponse>>>;
  emit: (paths: string[]) => void;
  subscribed: () => number;
  unsubscribed: () => number;
};

function harness(answer: (seat?: string) => CodeGraphResponse): Harness {
  const listeners = new Set<(paths: string[]) => void>();
  let unsubscribed = 0;
  const graph = vi.fn(async (_project: string, seat?: string) => answer(seat));
  const api: GraphApi = {
    graph,
    changes: async () => [],
    fileChanges: (_project, onBatch) => {
      listeners.add(onBatch);
      return () => { listeners.delete(onBatch); unsubscribed++; };
    },
  };
  return {
    api,
    graph,
    emit: paths => { for (const l of listeners) l(paths); },
    subscribed: () => listeners.size,
    unsubscribed: () => unsubscribed,
  };
}

describe("S-graph-refresh · the graph follows the watcher and the scope", () => {
  let host: HTMLDivElement;
  let root: Root;
  const evidence: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const card = (id: string) => host.querySelector<HTMLButtonElement>(`[data-graph-node="${id}"]`);
  const outOf = (id: string) => Number(/(\d+) out/.exec(card(id)?.title ?? "")?.[1] ?? NaN);
  const meta = () => host.querySelector('[data-testid="graph-meta"]')?.textContent ?? "";

  it("drill 2: an import appended and its target created rebuild once within the quiet second; outDegree rises by one", async () => {
    let current: CodeGraph = SIX_NODE_GRAPH;
    let release: (() => void) | null = null;
    const h = harness(() => current);
    // The rebuild answers only when the drill lets it, so the canvas can be inspected mid-build.
    h.graph.mockImplementation(async () => {
      if (release === null) return current;
      await new Promise<void>(resolve => { release = resolve; });
      return current;
    });

    act(() => root.render(<GraphView project="p" seat={null} onOpen={() => {}} api={h.api} />));
    await flush();
    expect(h.subscribed(), "the view subscribed to the project's file-changed batches").toBe(1);
    act(() => card("@dir:lib")?.click());

    const before = { out: outOf("lib/a.ts"), files: meta(), x: card("lib/x.ts") };
    expect(before.out, "positive control: lib/a.ts is on the canvas with a degree").toBe(1);
    expect(before.files).toContain("6 files · 4 edges");
    expect(before.x, "no x.ts before the edit").toBeNull();
    expect(h.graph).toHaveBeenCalledTimes(1);
    evidence.push(`before: lib/a.ts 1 out, 6 files, no x.ts`);

    current = withX(SIX_NODE_GRAPH);
    release = () => {};
    h.emit(["lib/a.ts"]);
    tick(300);
    h.emit(["lib/x.ts"]);
    h.emit(["graft/.graph/wiring.json", "graft/.cache/fingerprint.json"]);
    tick(QUIET_MS - 1);
    expect(h.graph, "three batches inside the quiet second: no rebuild yet").toHaveBeenCalledTimes(1);
    tick(1);
    expect(h.graph, "one rebuild a quiet second after the last source write").toHaveBeenCalledTimes(2);
    expect(h.graph).toHaveBeenLastCalledWith("p", undefined);
    await flush();
    expect(host.querySelector('[data-testid="graph-rebuilding"]'), "the header says rebuilding").not.toBeNull();
    expect(outOf("lib/a.ts"), "the old canvas stays up while graft runs").toBe(1);

    act(() => release?.());
    await flush();
    expect(host.querySelector('[data-testid="graph-rebuilding"]')).toBeNull();
    expect(outOf("lib/a.ts"), "outDegree rose by one").toBe(2);
    expect(card("lib/x.ts"), "x.ts appeared under the expanded lib/").not.toBeNull();
    expect(meta()).toContain("7 files · 5 edges");
    evidence.push(`after 1.3s: lib/a.ts 2 out, 7 files, x.ts on canvas, 1 rebuild for 3 batches`);

    h.emit(["graft/.cache/only"]);
    tick(QUIET_MS * 2);
    expect(h.graph, "graft's own output never triggers a rebuild").toHaveBeenCalledTimes(2);
    evidence.push("graft/ batch: 0 rebuilds");

    act(() => root.unmount());
    expect(h.unsubscribed(), "unmount unsubscribed from the watcher").toBe(1);
    root = createRoot(host);
  });

  it("drill 3: a seat scope shows the seat's uncommitted file and not the project's; the watcher does not drive a seat scope", async () => {
    const h = harness(seat => (seat === "kimi" ? SEAT_GRAPH : SIX_NODE_GRAPH));
    const render = (seat: string | null) => act(() => root.render(<GraphView project="p" seat={seat} onOpen={() => {}} api={h.api} />));

    render(null);
    await flush();
    act(() => card("@dir:lib")?.click());
    expect(card("lib/a.ts"), "positive control: lib/ is expanded on the project scope").not.toBeNull();
    expect(card("lib/new.ts"), "the project checkout has no new.ts").toBeNull();
    expect(h.graph).toHaveBeenLastCalledWith("p", undefined);
    evidence.push("project scope: no new.ts");

    render("kimi");
    expect(host.textContent).toContain("building the graph of seat/kimi");
    await flush();
    expect(h.graph).toHaveBeenLastCalledWith("p", "kimi");
    expect(card("lib/new.ts"), "the seat's uncommitted file is on the seat scope's canvas").not.toBeNull();
    expect(meta()).toContain("7 files");
    expect(h.subscribed(), "a seat scope has no watcher to hear (blueprint §2)").toBe(0);
    const calls = h.graph.mock.calls.length;
    h.emit(["lib/a.ts"]);
    tick(QUIET_MS * 2);
    expect(h.graph.mock.calls.length, "no watcher-driven rebuild under a seat scope").toBe(calls);
    evidence.push("seat/kimi: new.ts on canvas, 7 files, 0 watcher rebuilds");

    act(() => host.querySelector<HTMLButtonElement>('button[title^="Rebuild the graph"]')?.click());
    expect(h.graph.mock.calls.length, "the refresh chip is the seat scope's rebuild path").toBe(calls + 1);
    expect(h.graph).toHaveBeenLastCalledWith("p", "kimi");

    render(null);
    await flush();
    expect(card("lib/new.ts"), "back on the project scope, new.ts is gone").toBeNull();
    expect(h.subscribed()).toBe(1);
    evidence.push("refresh chip -> code_graph(p, kimi); project scope again: no new.ts");
    console.log(`  PASS  S-graph-refresh  ${evidence.join("; ")}`);
  });
});
