// @vitest-environment happy-dom
// The app drill for #7971 in the drill-surface form (a PASS line with evidence): the review chip
// on the Changes strip reads the scope's graph once, says the tier and the count, wears tr-warn
// at careful, names a path the graph has no node for, and opens the graph tab on click.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeGraph, GraphApi } from "./graph/graphApi";
import { SIX_NODE_GRAPH } from "./graph/fixture";
import { ReviewChip } from "./ReviewChip";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

/** lib/core.ts with ten importers: the blast >= 10 case, and nothing else about it is risky. */
const TEN_DEPENDENTS: CodeGraph = {
  root: "/fixture-ten",
  nodes: [
    { id: "lib/core.ts", name: "core.ts", cluster: "lib", chars: 100, inDegree: 10, outDegree: 0, isTest: false, testedBy: 1, orphan: false, doc: false, cycleId: null },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `bin/cmd${i}.ts`, name: `cmd${i}.ts`, cluster: "bin", chars: 50, inDegree: 0, outDegree: 1, isTest: false, testedBy: 1, orphan: false, doc: false, cycleId: null,
    })),
  ],
  edges: Array.from({ length: 10 }, (_, i) => ({ source: `bin/cmd${i}.ts`, target: "lib/core.ts", relation: "imports" as const })),
  meta: { files: 11, edges: 10, externalTargets: 0, cycles: 0, buildMs: 1 },
};

describe("S-review · the chip on the Changes strip", () => {
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

  const chip = () => host.querySelector<HTMLElement>('[data-testid="review-chip"]');

  it("blast 10 wears careful in tr-warn; the graph is read once per scope", async () => {
    let builds = 0;
    const api: GraphApi = { graph: async () => { builds += 1; return TEN_DEPENDENTS; }, changes: async () => [], fileChanges: () => () => {} };
    const opened: string[] = [];
    act(() => root.render(<ReviewChip project="ten" seat={null} path="lib/core.ts" onOpenGraph={() => opened.push("graph")} api={api} />));
    expect(chip()?.dataset.tier, "positive control: the chip mounts before the graph lands").toBe("loading");
    await flush();
    await flush();
    expect(chip()?.textContent).toBe("careful · 10 dependents");
    expect(chip()?.dataset.tier).toBe("careful");
    expect(chip()?.className).toContain("text-[var(--color-tr-warn)]");
    act(() => chip()?.click());
    expect(opened).toEqual(["graph"]);
    evidence.push(`lib/core.ts -> "${chip()?.textContent}" tr-warn, click opens the graph`);

    act(() => root.render(<ReviewChip project="ten" seat={null} path="bin/cmd3.ts" onOpenGraph={() => {}} api={api} />));
    await flush();
    await flush();
    expect(chip()?.textContent).toBe("skim · 0 dependents");
    expect(chip()?.className).not.toContain("tr-warn");
    expect(builds, "the second path under the same scope reuses the graph").toBe(1);
    evidence.push(`bin/cmd3.ts -> "${chip()?.textContent}", ${builds} build`);
  });

  it("three dependents in a cycle read careful; a test reads skim; a config path is not in the graph", async () => {
    const api: GraphApi = { graph: async () => SIX_NODE_GRAPH, changes: async () => [], fileChanges: () => () => {} };
    for (const [path, text, tier] of [
      ["lib/a.ts", "careful · 3 dependents", "careful"],
      ["test/a.test.ts", "skim · 0 dependents", "skim"],
      ["package.json", "not in the graph", "none"],
    ] as const) {
      act(() => root.render(<ReviewChip project="six" seat="kimi" path={path} onOpenGraph={() => {}} api={api} />));
      await flush();
      await flush();
      expect(chip()?.textContent).toBe(text);
      expect(chip()?.dataset.tier).toBe(tier);
      evidence.push(`${path} -> "${text}"`);
    }
  });

  it("a missing graft says the graph is unavailable, never a tier", async () => {
    const api: GraphApi = { graph: async () => ({ error: "graft not installed" }), changes: async () => [], fileChanges: () => () => {} };
    act(() => root.render(<ReviewChip project="none" seat={null} path="lib/a.ts" onOpenGraph={() => {}} api={api} />));
    await flush();
    await flush();
    expect(chip()?.textContent).toBe("graph unavailable");
    expect(chip()?.dataset.tier).toBe("unavailable");
    evidence.push("graft absent -> graph unavailable");
    console.log(`  PASS  S-review · review chip  ${evidence.join("; ")}`);
  });
});
