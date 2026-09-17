// The unit drill for #7978: squarify packs areas that sum to the pane, the districts model
// nests file tiles in cluster blocks by size, and the Hotspots rank puts the big, churned file
// first, with lib.rs as the fixture's stand-in for this repo's own.
import { describe, expect, it } from "vitest";
import { deriveGraph, hotspotRank, hotspotRaw, type GraphView } from "./deriveGraph";
import { districtsOf, largestTile, squarify } from "./districts";
import { HOTSPOT_GRAPH, SIX_NODE_GRAPH } from "./fixture";

const view = (over: Partial<GraphView> = {}): GraphView => ({
  expanded: new Set(["bin", "docs", "lib", "test", "desktop"]),
  lens: "hotspots",
  dirty: [],
  selected: null,
  ...over,
});

describe("squarify", () => {
  it("fills the pane: areas sum to the frame and every tile sits inside it", () => {
    const rects = squarify([{ id: "a", value: 6 }, { id: "b", value: 3 }, { id: "c", value: 1 }], 0, 0, 100, 50);
    expect(rects.map(r => r.id)).toEqual(["a", "b", "c"]);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(5000, 6);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(50 + 1e-9);
    }
    expect(rects[0].w * rects[0].h).toBeCloseTo(3000, 6);
  });

  it("drops zero-weight items and answers nothing for an empty list", () => {
    expect(squarify([{ id: "z", value: 0 }], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
  });
});

describe("hotspotRank", () => {
  it("keeps Flare's formula and caps churn at 50", () => {
    expect(hotspotRaw({ complexity: 10, churn: 3 }, 0)).toBe(40);
    expect(hotspotRaw({ complexity: 10, churn: 112 }, 0)).toBe(510);
    expect(hotspotRaw({ complexity: 10, churn: 0 }, 2)).toBe(70);
  });

  it("ranks lib.rs first with heat 100 and a flat repo all at 0", () => {
    const ranked = hotspotRank(HOTSPOT_GRAPH, []);
    expect(ranked[0]).toMatchObject({ id: "desktop/src-tauri/src/lib.rs", heat: 100, raw: 762 * 51 });
    expect(ranked[1]).toMatchObject({ id: "lib/a.ts", raw: 40 * 21 });
    expect(ranked[ranked.length - 1].heat).toBe(0);
    expect(hotspotRank(SIX_NODE_GRAPH, []).every(h => h.heat === 0)).toBe(true);
  });

  it("a seat's uncommitted work on a path is session churn, three commits' worth", () => {
    const ranked = hotspotRank(HOTSPOT_GRAPH, [{ path: "lib/a.ts", seat: "kimi" }]);
    expect(ranked[1]).toMatchObject({ id: "lib/a.ts", sessionChurn: 1, raw: 40 * 24 });
  });
});

describe("deriveGraph under the Hotspots lens", () => {
  it("carries heat and size on every card and dims the unheated", () => {
    const d = deriveGraph(HOTSPOT_GRAPH, view());
    const lib = d.nodes.find(n => n.id === "desktop/src-tauri/src/lib.rs");
    expect(lib).toMatchObject({ heat: 100, chars: 300_000, tone: "calm" });
    expect(d.nodes.find(n => n.id === "lib/stray.ts")).toMatchObject({ heat: 0, tone: "dim" });
    expect(d.edges.every(e => e.tone === "dim")).toBe(true);
    const folded = deriveGraph(HOTSPOT_GRAPH, view({ expanded: new Set() }));
    expect(folded.nodes.find(n => n.id === "@dir:desktop")).toMatchObject({ heat: 100, chars: 300_000 });
    expect(folded.nodes.find(n => n.id === "@dir:lib")?.chars).toBe(60_000);
  });
});

describe("districtsOf", () => {
  it("nests every file tile inside its cluster block and draws lib.rs as the largest rectangle", () => {
    const d = deriveGraph(HOTSPOT_GRAPH, view());
    const districts = districtsOf(d.nodes, 800, 500);
    expect(districts.blocks.map(b => b.cluster).sort()).toEqual(["bin", "desktop", "docs", "lib", "test"]);
    expect(districts.tiles).toHaveLength(7);
    for (const t of districts.tiles) {
      const block = districts.blocks.find(b => b.cluster === (t.node.cluster || "(root)"));
      expect(block).toBeDefined();
      if (!block) continue;
      expect(t.x).toBeGreaterThanOrEqual(block.x - 1e-9);
      expect(t.y).toBeGreaterThanOrEqual(block.y - 1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(block.x + block.w + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(block.y + block.h + 1e-9);
    }
    expect(largestTile(districts)?.node.id).toBe("desktop/src-tauri/src/lib.rs");
    const desktop = districts.blocks.find(b => b.cluster === "desktop");
    expect(desktop).toMatchObject({ files: 1, chars: 300_000, heat: 100 });
  });

  it("a tiny file still gets a tile, cluster cards are ignored, a sliver of a block holds none", () => {
    const d = deriveGraph(HOTSPOT_GRAPH, view({ expanded: new Set(["lib"]) }));
    const districts = districtsOf(d.nodes, 400, 300);
    expect(districts.blocks.map(b => b.cluster)).toEqual(["lib"]);
    expect(districts.tiles.map(t => t.node.id).sort()).toEqual(["lib/a.ts", "lib/b.ts", "lib/stray.ts"]);
    expect(districts.tiles.every(t => t.w > 0 && t.h > 0)).toBe(true);
    const full = deriveGraph(HOTSPOT_GRAPH, view());
    const thin = districtsOf(full.nodes.map(n => (n.id.endsWith("lib.rs") ? { ...n, chars: 3e7 } : n)), 800, 500);
    expect(thin.tiles.map(t => t.node.id)).toEqual(["desktop/src-tauri/src/lib.rs"]);
    expect(thin.blocks).toHaveLength(5);
  });
});
