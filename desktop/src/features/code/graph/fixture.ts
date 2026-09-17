// The six-node drill fixture (#7954 §5 card 2), in code_graph's exact JSON form: lib/a.ts and
// lib/b.ts import each other (one 2-cycle), bin/cli.ts and test/a.test.ts import a, lib/stray.ts
// is an orphan, docs/README.md is prose. Four top-level directories, one of them a test dir.
import type { CodeGraph, GraphNode } from "./graphApi";

const node = (id: string, cluster: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id.split("/").pop() ?? id,
  cluster,
  chars: 100,
  inDegree: 0,
  outDegree: 0,
  isTest: false,
  testedBy: 0,
  orphan: false,
  doc: false,
  cycleId: null,
  ...over,
});

export const SIX_NODE_GRAPH: CodeGraph = {
  root: "/fixture",
  nodes: [
    node("lib/a.ts", "lib", { inDegree: 3, outDegree: 1, testedBy: 1, cycleId: 0 }),
    node("lib/b.ts", "lib", { inDegree: 1, outDegree: 1, cycleId: 0 }),
    node("lib/stray.ts", "lib", { orphan: true }),
    node("bin/cli.ts", "bin", { outDegree: 1 }),
    node("test/a.test.ts", "test", { outDegree: 1, isTest: true }),
    node("docs/README.md", "docs", { doc: true }),
  ],
  edges: [
    { source: "lib/a.ts", target: "lib/b.ts", relation: "imports" },
    { source: "lib/b.ts", target: "lib/a.ts", relation: "imports" },
    { source: "bin/cli.ts", target: "lib/a.ts", relation: "imports" },
    { source: "test/a.test.ts", target: "lib/a.ts", relation: "imports" },
  ],
  meta: { files: 6, edges: 4, externalTargets: 0, cycles: 1, buildMs: 1 },
};

/** The fixture's top-level directories: what cluster zoom must show, one card each. */
export const SIX_NODE_CLUSTERS = ["bin", "docs", "lib", "test"];
