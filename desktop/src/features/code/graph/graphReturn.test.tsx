// @vitest-environment happy-dom
// The way back from the graph (#11603): the view state survives GraphView unmounting, one project's
// graph never shows in another, and the Back chip appears only for the file the graph opened.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphView } from "../GraphView";
import { BackToGraph } from "./BackToGraph";
import { isGraphBackKey } from "./graphOrigin";
import { graphViewState, resetGraphViewStates, saveGraphViewState } from "./graphViewState";
import type { GraphApi } from "./graphApi";
import { SIX_NODE_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const api: GraphApi = { graph: async () => SIX_NODE_GRAPH, changes: async () => [], fileChanges: () => () => {} };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { resetGraphViewStates(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async (project: string) => {
  act(() => root.render(<GraphView key={project} project={project} seat={null} onOpen={() => {}} api={api} />));
  await flush();
};
const click = (el: Element | null) => {
  act(() => {
    // SAFETY: every element passed in is a button the test just queried, and a button is an HTMLElement.
    (el as HTMLElement).click();
  });
};
const tab = (group: string, name: string) =>
  [...host.querySelectorAll(`[data-testid="${group}"] button`)].find(b => b.textContent === name) ?? null;

describe("graph view state", () => {
  it("round-trips layout, lens, expanded districts and selection across unmount and remount", async () => {
    await mount("p");
    click(tab("graph-lens", "hotspots"));
    click(tab("graph-layout", "districts"));
    click(tab("graph-layout", "flow"));
    const cluster = host.querySelector('[data-graph-kind="cluster"]');
    const clusterId = cluster?.getAttribute("data-graph-node") ?? "";
    click(cluster);
    const file = host.querySelector('[data-graph-kind="file"]');
    const fileId = file?.getAttribute("data-graph-node") ?? "";
    click(file);

    act(() => root.unmount());
    root = createRoot(host);
    await mount("p");

    expect(tab("graph-lens", "hotspots")?.getAttribute("data-on")).toBe("true");
    expect(tab("graph-layout", "flow")?.getAttribute("data-on")).toBe("true");
    expect(host.querySelector(`[data-graph-node="${fileId}"]`)).not.toBeNull();
    expect(clusterId).not.toBe("");
    expect(graphViewState("p").expanded.size).toBe(1);
    expect(graphViewState("p").selected).toBe(fileId);
    expect(host.querySelector(`[data-graph-node="${fileId}"]`)?.getAttribute("data-graph-tone")).toBe("selected");
  });

  it("restores the districts layout and the pan", async () => {
    saveGraphViewState("p", { layout: "districts", scrollLeft: 40, scrollTop: 25 });
    await mount("p");
    expect(tab("graph-layout", "districts")?.getAttribute("data-on")).toBe("true");
    // SAFETY: graph-canvas is the GraphView's scroll container, a div, and the mount above awaited it.
    const canvas = host.querySelector('[data-testid="graph-canvas"]') as HTMLElement;
    expect(canvas.scrollLeft).toBe(40);
    expect(canvas.scrollTop).toBe(25);
  });

  it("keeps each project's graph to itself", async () => {
    await mount("a");
    click(tab("graph-lens", "hotspots"));
    await mount("b");
    expect(tab("graph-lens", "clusters")?.getAttribute("data-on")).toBe("true");
    expect(graphViewState("a").lens).toBe("hotspots");
    expect(graphViewState("b").lens).toBe("clusters");
  });
});

describe("BackToGraph", () => {
  const render = (origin: { project: string; path: string } | null, project: string, activePath: string | null, onBack = () => {}) =>
    act(() => root.render(<BackToGraph origin={origin} project={project} activePath={activePath} onBack={onBack} />));

  it("shows only for the file the graph opened, in that project", () => {
    render(null, "p", "src/a.ts");
    expect(host.querySelector('[data-testid="back-to-graph"]')).toBeNull();
    render({ project: "p", path: "src/a.ts" }, "p", "src/b.ts");
    expect(host.querySelector('[data-testid="back-to-graph"]')).toBeNull();
    render({ project: "p", path: "src/a.ts" }, "other", "src/a.ts");
    expect(host.querySelector('[data-testid="back-to-graph"]')).toBeNull();
    render({ project: "p", path: "src/a.ts" }, "p", "src/a.ts");
    expect(host.querySelector('[data-testid="back-to-graph"]')).not.toBeNull();
  });

  it("returns to the graph when clicked", () => {
    let backs = 0;
    render({ project: "p", path: "src/a.ts" }, "p", "src/a.ts", () => { backs++; });
    click(host.querySelector('[data-testid="back-to-graph"]'));
    expect(backs).toBe(1);
  });

  it("recognises Cmd+[ and Ctrl+[ only", () => {
    expect(isGraphBackKey({ metaKey: true, ctrlKey: false, key: "[" })).toBe(true);
    expect(isGraphBackKey({ metaKey: false, ctrlKey: true, key: "[" })).toBe(true);
    expect(isGraphBackKey({ metaKey: false, ctrlKey: false, key: "[" })).toBe(false);
    expect(isGraphBackKey({ metaKey: true, ctrlKey: false, key: "]" })).toBe(false);
  });
});
