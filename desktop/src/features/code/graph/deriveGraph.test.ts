// The unit drill for #7954: deriveGraph over the six-node fixture with one 2-cycle yields the
// expected cluster cards, expands one cluster to its files, and colours the cycle pair.
import { describe, expect, it } from "vitest";
import { clusterId, deriveGraph, dirtyMarks, hiddenEdges, toggleCluster, type GraphView } from "./deriveGraph";
import { SIX_NODE_CLUSTERS, SIX_NODE_GRAPH } from "./fixture";

const view = (over: Partial<GraphView> = {}): GraphView => ({
  expanded: new Set(),
  lens: "clusters",
  dirty: [],
  selected: null,
  ...over,
});

describe("deriveGraph at cluster zoom", () => {
  it("draws one card per top-level directory and only the edges that cross clusters", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view());
    expect(d.clusters).toEqual(SIX_NODE_CLUSTERS);
    expect(d.nodes.map(n => n.id)).toEqual(SIX_NODE_CLUSTERS.map(clusterId));
    expect(d.nodes.every(n => n.kind === "cluster")).toBe(true);
    const lib = d.nodes.find(n => n.id === clusterId("lib"));
    expect(lib?.files).toBe(3);
    expect(lib?.cycle).toBe(true);
    expect(lib?.inDegree).toBe(2);
    expect(d.nodes.find(n => n.id === clusterId("docs"))?.cycle).toBe(false);
    expect(d.edges.map(e => `${e.source} -> ${e.target}`)).toEqual([
      "@dir:bin -> @dir:lib",
      "@dir:test -> @dir:lib",
    ]);
    expect(d.edges.every(e => e.relation === "imports" && !e.cycle)).toBe(true);
    expect(hiddenEdges(SIX_NODE_GRAPH, d)).toBe(2);
  });

  it("folds root files into a (root) cluster card", () => {
    const withRoot = {
      ...SIX_NODE_GRAPH,
      nodes: [...SIX_NODE_GRAPH.nodes, { ...SIX_NODE_GRAPH.nodes[3], id: "hub.mjs", name: "hub.mjs", cluster: "" }],
    };
    const d = deriveGraph(withRoot, view());
    expect(d.clusters).toEqual(["(root)", ...SIX_NODE_CLUSTERS]);
    expect(d.nodes[0]).toMatchObject({ id: "@dir:(root)", kind: "cluster", label: "(root)", files: 1 });
  });
});

describe("deriveGraph with lib expanded", () => {
  const expanded = toggleCluster(new Set(), "lib");

  it("replaces the lib card with its three files and rewires edges to them", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded }));
    expect(d.nodes.map(n => n.id)).toEqual(["@dir:bin", "@dir:docs", "lib/a.ts", "lib/b.ts", "lib/stray.ts", "@dir:test"]);
    expect(d.nodes.filter(n => n.kind === "file").map(n => n.label)).toEqual(["a.ts", "b.ts", "stray.ts"]);
    expect(d.edges.map(e => `${e.source} -> ${e.target}`)).toEqual([
      "@dir:bin -> lib/a.ts",
      "@dir:test -> lib/a.ts",
      "lib/a.ts -> lib/b.ts",
      "lib/b.ts -> lib/a.ts",
    ]);
    expect(d.edges.filter(e => e.cycle).map(e => e.id)).toEqual(["lib/a.ts\nlib/b.ts", "lib/b.ts\nlib/a.ts"]);
    expect(hiddenEdges(SIX_NODE_GRAPH, d)).toBe(0);
  });

  it("toggling lib again collapses it", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded: toggleCluster(expanded, "lib") }));
    expect(d.nodes).toHaveLength(4);
  });

  it("Cycles lens colours the pair and their two edges warn, everything else dim", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded, lens: "cycles" }));
    const tones = new Map(d.nodes.map(n => [n.id, n.tone]));
    expect(tones.get("lib/a.ts")).toBe("warn");
    expect(tones.get("lib/b.ts")).toBe("warn");
    expect(tones.get("lib/stray.ts")).toBe("dim");
    expect(tones.get("@dir:docs")).toBe("dim");
    expect(d.edges.map(e => e.tone)).toEqual(["dim", "dim", "warn", "warn"]);
  });

  it("Unread lens colours a claimed, unopened file unread, a read one read, and folds the state onto the cluster card", () => {
    const unread = new Map([["lib/a.ts", "unread" as const], ["lib/b.ts", "read" as const], ["bin/cli.ts", "read" as const]]);
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded, lens: "unread", unread }));
    const tones = new Map(d.nodes.map(n => [n.id, n.tone]));
    expect(tones.get("lib/a.ts")).toBe("unread");
    expect(tones.get("lib/b.ts")).toBe("read");
    expect(tones.get("lib/stray.ts")).toBe("calm");
    expect(tones.get("@dir:bin")).toBe("read");
    expect(tones.get("@dir:docs")).toBe("calm");
    expect(d.edges.every(e => e.tone === "calm")).toBe(true);
    const folded = deriveGraph(SIX_NODE_GRAPH, view({ lens: "unread", unread }));
    expect(folded.nodes.find(n => n.id === "@dir:lib")?.tone).toBe("unread");
    expect(deriveGraph(SIX_NODE_GRAPH, view({ expanded, lens: "unread" })).nodes.every(n => n.tone === "calm")).toBe(true);
  });

  it("Activity lens keeps the dirty nodes and their edges, dims the rest, and names the seat", () => {
    const dirty = dirtyMarks([{ seat: "kimi", path: "lib/a.ts" }, { seat: null, path: "lib/a.ts" }, { seat: "glm", path: "bin/cli.ts" }]);
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded, lens: "activity", dirty }));
    const a = d.nodes.find(n => n.id === "lib/a.ts");
    expect(a?.seats).toEqual(["kimi", null]);
    expect(a?.tone).toBe("calm");
    expect(d.nodes.find(n => n.id === "@dir:bin")?.seats).toEqual(["glm"]);
    expect(d.nodes.find(n => n.id === "lib/b.ts")?.tone).toBe("dim");
    expect(d.edges.find(e => e.id === "@dir:bin\nlib/a.ts")?.tone).toBe("calm");
    expect(d.edges.find(e => e.id === "@dir:test\nlib/a.ts")?.tone).toBe("calm");
  });

  it("at cluster zoom a seat's dirty file still shows as a dot on the cluster card", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view({ dirty: dirtyMarks([{ seat: "kimi", path: "lib/a.ts" }]) }));
    expect(d.nodes.find(n => n.id === "@dir:lib")?.seats).toEqual(["kimi"]);
  });

  it("selecting a file marks it and its direct neighbours, over any lens", () => {
    const d = deriveGraph(SIX_NODE_GRAPH, view({ expanded, lens: "cycles", selected: "lib/a.ts" }));
    const tones = new Map(d.nodes.map(n => [n.id, n.tone]));
    expect(tones.get("lib/a.ts")).toBe("selected");
    expect(tones.get("lib/b.ts")).toBe("linked");
    expect(tones.get("@dir:bin")).toBe("linked");
    expect(tones.get("lib/stray.ts")).toBe("dim");
    expect(d.edges.filter(e => e.tone === "linked")).toHaveLength(4);
  });
});
