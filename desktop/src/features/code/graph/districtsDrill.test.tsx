// @vitest-environment happy-dom
// The #7978 app drill in drill-surface form: under the Hotspots lens the header names lib.rs
// hottest (the fixture stands in for this repo; the Rust drill ranks the real checkout), the
// districts layout draws it as the largest rectangle, and clicking the tile opens the file.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphView } from "../GraphView";
import type { GraphApi } from "./graphApi";
import { HOTSPOT_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const fakeApi = (): GraphApi => ({
  graph: async () => HOTSPOT_GRAPH,
  changes: async () => [{ seat: "kimi", path: "lib/a.ts", status: "M", plus: 1, minus: 0 }],
  fileChanges: () => () => {},
});

describe("S-districts · the Hotspots lens and the districts layout", () => {
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

  const seg = (testId: string, label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(`[data-testid="${testId}"] button`)].find(b => b.textContent === label);
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  const tiles = () => [...host.querySelectorAll<HTMLElement>('[data-testid="districts-view"] [data-graph-node]')];

  it("ranks lib.rs hottest, draws it as the largest rectangle, and a tile click opens it", async () => {
    const opened: string[] = [];
    act(() => root.render(<GraphView project="p" seat={null} onOpen={p => opened.push(p)} api={fakeApi()} />));
    await flush();

    expect(host.querySelector('[data-testid="graph-hottest"]'), "no rank line outside the lens").toBeNull();
    act(() => seg("graph-lens", "hotspots")?.click());
    const hottest = host.querySelector('[data-testid="graph-hottest"]')?.textContent ?? "";
    expect(hottest).toContain("hottest: desktop/src-tauri/src/lib.rs");
    expect(hottest).toContain("complexity 762 · churn 112");
    expect(card("@dir:desktop")?.dataset.graphHeat).toBe("100");
    expect(card("@dir:docs")?.dataset.graphTone).toBe("dim");
    evidence.push(`flow: ${hottest}`);

    act(() => card("@dir:desktop")?.click());
    const libCard = card("desktop/src-tauri/src/lib.rs");
    expect(libCard?.dataset.graphHeat).toBe("100");
    expect(card("@dir:docs")?.dataset.graphHeat).toBe("0");

    act(() => seg("graph-layout", "districts")?.click());
    expect(host.querySelector('[data-testid="districts-view"]')).not.toBeNull();
    expect(tiles()).toHaveLength(7);
    const areas = tiles().map(t => ({ id: t.dataset.graphNode ?? "", area: Number(t.dataset.graphArea) }));
    areas.sort((a, b) => b.area - a.area);
    expect(areas[0].id).toBe("desktop/src-tauri/src/lib.rs");
    expect(areas[0].area).toBeGreaterThan(areas[1].area * 5);
    expect(host.querySelectorAll("[data-district]")).toHaveLength(5);
    expect(card("lib/a.ts")?.querySelector('[data-graph-seat="kimi"]'), "the seat dot rides the tile").not.toBeNull();
    evidence.push(`districts: largest ${areas[0].id} area=${areas[0].area}, next ${areas[1].id} area=${areas[1].area}`);

    act(() => card("desktop/src-tauri/src/lib.rs")?.click());
    expect(opened).toEqual(["desktop/src-tauri/src/lib.rs"]);
    expect(card("desktop/src-tauri/src/lib.rs")?.dataset.graphTone).toBe("selected");

    act(() => seg("graph-layout", "flow")?.click());
    expect(host.querySelector('[data-testid="districts-view"]')).toBeNull();
    expect(card("desktop/src-tauri/src/lib.rs"), "the flow layout keeps the expansion").not.toBeNull();
    console.log(`PASS S-districts · ${evidence.join(" | ")}`);
  });
});
