// @vitest-environment happy-dom
// S-graph, the app drill for #7954 in the drill-surface form (a PASS line with evidence): chip
// asks for GRAPH_PATH -> the scope's pinned graph tab -> cluster zoom (count asserted non-zero
// first) -> expand lib/ -> a card click opens a code tab under the same scope (tab strip text).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubClient } from "../../../shared/api/client";
import { GRAPH_PATH, openGraphTab, openInTabs, tabKey, tabLabel, type CodeTab } from "../codeTabs";
import { GraphView } from "../GraphView";
import { ModePane } from "../ModePane";
import type { GraphApi } from "./graphApi";
import { SIX_NODE_CLUSTERS, SIX_NODE_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const fakeApi = (over: Partial<GraphApi> = {}): GraphApi => ({
  graph: async () => SIX_NODE_GRAPH,
  changes: async () => [{ seat: "kimi", path: "lib/a.ts", status: "M", plus: 1, minus: 0 }],
  fileChanges: () => () => {},
  ...over,
});

describe("S-graph · graph view on the Code surface", () => {
  let host: HTMLDivElement;
  let root: Root;
  const evidence: string[] = [];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // Rendered and clicked inside one act, as tabStrip.test.tsx does: settling the pane's effects
  // would reach Tauri's listen(), which has no host under happy-dom.
  it("the footer graph chip asks Files for the graph, not a file", () => {
    const opened: string[] = [];
    const stubClient: HubClient = Object.assign(Object.create(HubClient.prototype), {
      peers: async () => [],
      tasks: async () => [],
    });
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={p => opened.push(p)} />,
    ));
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="graph-chip"]');
    expect(chip, "the graph chip sits in the Files footer").not.toBeNull();
    act(() => chip?.click());
    expect(opened).toEqual([GRAPH_PATH]);
    evidence.push(`chip -> onOpenFile(${GRAPH_PATH})`);
  });

  it("GRAPH_PATH opens one pinned graph tab per scope", () => {
    const start: CodeTab[] = [{ key: tabKey("project", "x.ts"), scope: "project", path: "x.ts", view: "code", pinned: false, dirty: false }];
    const project = openGraphTab(start, "project");
    expect(project.activeKey).toBe("project:@graph");
    expect(project.tabs.map(tabLabel)).toEqual(["x.ts", "graph"]);
    expect(project.tabs[1]).toMatchObject({ view: "graph", pinned: true, scope: "project" });
    const again = openGraphTab(project.tabs, "project");
    expect(again.tabs).toBe(project.tabs);
    const seat = openGraphTab(project.tabs, "kimi");
    expect(seat.tabs.filter(t => t.view === "graph").map(t => t.key)).toEqual(["project:@graph", "kimi:@graph"]);
    evidence.push("graph tab pinned, keyed project:@graph and kimi:@graph");
  });

  it("cluster zoom, expand lib/, click a card: a code tab opens under the same scope", async () => {
    const opened: string[] = [];
    act(() => root.render(<GraphView project="p" seat={null} onOpen={p => opened.push(p)} api={fakeApi()} />));
    await flush();
    await flush();

    const nodesAt = () => host.querySelectorAll<HTMLButtonElement>("[data-graph-node]");
    const clusterCards = nodesAt();
    expect(clusterCards.length, "positive control: the canvas mounted cards").toBeGreaterThan(0);
    expect(clusterCards.length, "one card per top-level directory with code").toBe(SIX_NODE_CLUSTERS.length);
    expect([...clusterCards].every(c => c.dataset.graphKind === "cluster")).toBe(true);
    expect(host.querySelector('[data-graph-node="@dir:lib"] [data-graph-seat="kimi"]'), "kimi's dirty file shows on the lib card").not.toBeNull();
    expect(host.querySelectorAll("[data-graph-edge]").length).toBe(2);
    expect(host.querySelector('[data-testid="graph-meta"]')?.textContent).toContain("6 files · 4 edges · 4 clusters · 1 cycles");
    evidence.push(`cluster zoom: ${clusterCards.length} cards = ${SIX_NODE_CLUSTERS.join(",")}`);

    act(() => host.querySelector<HTMLButtonElement>('[data-graph-node="@dir:lib"]')?.click());
    const expandedIds = [...nodesAt()].map(n => n.dataset.graphNode);
    expect(expandedIds).toEqual(["@dir:bin", "@dir:docs", "lib/a.ts", "lib/b.ts", "lib/stray.ts", "@dir:test"]);
    expect(host.querySelectorAll("[data-graph-edge]").length).toBe(4);
    evidence.push(`expand lib/: ${expandedIds.length} cards`);

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="graph-lens"] button:nth-child(3)')?.click());
    const warn = [...nodesAt()].filter(n => n.dataset.graphTone === "warn").map(n => n.dataset.graphNode);
    expect(warn).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(host.querySelectorAll('[data-graph-edge][data-graph-tone="warn"]').length).toBe(2);
    evidence.push(`cycles lens: ${warn.join(" <-> ")} warn`);

    act(() => host.querySelector<HTMLButtonElement>('[data-graph-node="lib/a.ts"]')?.click());
    expect(opened).toEqual(["lib/a.ts"]);
    expect(host.querySelector<HTMLButtonElement>('[data-graph-node="lib/a.ts"]')?.dataset.graphTone).toBe("selected");

    // Files.tsx answers onOpen with openPath(activeScope, path, "code"): the same pure step.
    const graphTab = openGraphTab([], "project");
    const after = openInTabs(graphTab.tabs, graphTab.activeKey, "project", "lib/a.ts", "code");
    expect(after.tabs.map(tabLabel)).toEqual(["graph", "a.ts"]);
    expect(after.tabs[1]).toMatchObject({ scope: "project", view: "code", pinned: false });
    expect(after.activeKey).toBe("project:lib/a.ts");
    evidence.push(`click lib/a.ts -> tab strip "graph | a.ts", active project:lib/a.ts`);
  });

  it("a missing graft answers the error string where the canvas would be, never an empty graph", async () => {
    act(() => root.render(
      <GraphView project="p" seat="kimi" onOpen={() => {}} api={fakeApi({ graph: async () => ({ error: "graft not installed" }) })} />,
    ));
    await flush();
    await flush();
    expect(host.querySelectorAll("[data-graph-node]").length).toBe(0);
    expect(host.querySelector('[data-testid="graph-error"]')?.textContent).toContain("npm i -g @nanonets/graft");
    evidence.push("PATH without graft: error card, 0 nodes");
    console.log(`  PASS  S-graph · graph view  ${evidence.join("; ")}`);
  });
});
