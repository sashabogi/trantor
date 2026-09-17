// Vendored with flowLayout.ts from Flare tests/flowLayout.test.ts (5adc94b, MIT, see
// LICENSE.flare); adapted to the Map return type. The four properties the view relies on:
// dependencies left of dependents, longest path wins, cycles share a column, determinism.
import { describe, expect, it } from "vitest";
import { findCycles, flowLayout, hierarchicalFlowLayout, type Point } from "./flowLayout";

const at = (layout: Map<string, Point>, id: string): Point => {
  const p = layout.get(id);
  if (!p) throw new Error(`no position for ${id}`);
  return p;
};

describe("findCycles", () => {
  it("ids components of size two or more only", () => {
    const cycles = findCycles(new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["a"]],
      ["d", []],
    ]));
    expect(cycles.get("a")).toBe(cycles.get("b"));
    expect(cycles.has("c")).toBe(false);
    expect(cycles.has("d")).toBe(false);
  });
});

describe("flowLayout", () => {
  it("places dependencies left of dependents", () => {
    const pos = flowLayout(
      [
        { id: "util.ts", cluster: "src" },
        { id: "mid.ts", cluster: "src" },
        { id: "app.ts", cluster: "src" },
      ],
      [
        { source: "app.ts", target: "mid.ts" },
        { source: "mid.ts", target: "util.ts" },
      ],
    );
    expect(at(pos, "util.ts").x).toBeLessThan(at(pos, "mid.ts").x);
    expect(at(pos, "mid.ts").x).toBeLessThan(at(pos, "app.ts").x);
  });

  it("uses longest path, not shortest", () => {
    const pos = flowLayout(
      [
        { id: "util", cluster: "" },
        { id: "mid", cluster: "" },
        { id: "app", cluster: "" },
      ],
      [
        { source: "app", target: "mid" },
        { source: "mid", target: "util" },
        { source: "app", target: "util" },
      ],
    );
    expect(at(pos, "app").x).toBeGreaterThan(at(pos, "mid").x);
  });

  it("collapses cycles into one column and stacks members", () => {
    const pos = flowLayout(
      [
        { id: "a", cluster: "" },
        { id: "b", cluster: "" },
        { id: "entry", cluster: "" },
      ],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "entry", target: "a" },
      ],
    );
    expect(at(pos, "a").x).toBe(at(pos, "b").x);
    expect(at(pos, "a").y).not.toBe(at(pos, "b").y);
    expect(at(pos, "entry").x).toBeGreaterThan(at(pos, "a").x);
  });

  it("is deterministic and covers isolated nodes", () => {
    const nodes = [
      { id: "x", cluster: "a" },
      { id: "y", cluster: "b" },
      { id: "z", cluster: "a" },
    ];
    const a = flowLayout(nodes, []);
    const b = flowLayout(nodes, []);
    expect(a).toEqual(b);
    expect(a.size).toBe(3);
    expect(new Set([at(a, "x").y, at(a, "y").y, at(a, "z").y]).size).toBe(3);
  });
});

describe("hierarchicalFlowLayout", () => {
  const nodes = [
    { id: "lib/a.ts", cluster: "lib" },
    { id: "lib/b.ts", cluster: "lib" },
    { id: "app/x.ts", cluster: "app" },
    { id: "app/y.ts", cluster: "app" },
    { id: "@dir:tests", cluster: "tests" },
  ];
  const edges = [
    { source: "lib/b.ts", target: "lib/a.ts" },
    { source: "app/x.ts", target: "lib/a.ts" },
    { source: "app/y.ts", target: "app/x.ts" },
    { source: "@dir:tests", target: "app/x.ts" },
  ];

  it("orders cluster blocks by dependency and keeps members local", () => {
    const pos = hierarchicalFlowLayout(nodes, edges);
    expect(pos.size).toBe(5);
    const libX = (at(pos, "lib/a.ts").x + at(pos, "lib/b.ts").x) / 2;
    const appX = (at(pos, "app/x.ts").x + at(pos, "app/y.ts").x) / 2;
    expect(libX).toBeLessThan(appX);
    expect(appX).toBeLessThan(at(pos, "@dir:tests").x);
    const libSpread = Math.abs(at(pos, "lib/a.ts").x - at(pos, "lib/b.ts").x);
    expect(libSpread).toBeLessThan(appX - libX);
    expect(at(pos, "lib/a.ts").x).toBeLessThan(at(pos, "lib/b.ts").x);
  });

  it("is deterministic", () => {
    expect(hierarchicalFlowLayout(nodes, edges)).toEqual(hierarchicalFlowLayout(nodes, edges));
  });
});
