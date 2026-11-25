// @vitest-environment happy-dom
// #14268: the file tab says in plain words who imports it, and says nothing when the graph has no answer.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeGraph, CodeGraphResponse, GraphApi } from "../../../features/code/graph/graphApi";
import { ImportedBy, importedByText, importersOf } from "./ImportedBy";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string) => ({ id, name: id, cluster: "", chars: 1, inDegree: 0, outDegree: 0, isTest: false, testedBy: 0, orphan: false, doc: false, cycleId: null });
// SAFETY: the fixture carries only the fields ImportedBy reads, which is every field it touches on a CodeGraph.
const graph = { root: "/r", nodes: ["a.ts", "b.ts", "c.ts", "lonely.ts"].map(node), edges: [{ source: "a.ts", target: "c.ts" }, { source: "b.ts", target: "c.ts" }, { source: "a.ts", target: "b.ts" }] } as CodeGraph;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
let n = 0;
const mount = async (path: string, response: Promise<CodeGraphResponse>, onOpenFile?: (p: string) => void) => {
  // A distinct project keeps the shared graph cache apart per test.
  const api: GraphApi = { graph: () => response, changes: async () => [], fileChanges: () => () => undefined };
  await act(async () => { root.render(<ImportedBy project={`p${n++}`} scope={null} path={path} onOpenFile={onOpenFile} api={api} />); });
  await flush();
};

describe("ImportedBy", () => {
  it("words the count plainly and finds direct importers", () => {
    expect(importedByText(0)).toBe("No other files import this");
    expect(importedByText(1)).toBe("Imported by 1 file");
    expect(importedByText(2)).toBe("Imported by 2 files");
    expect(importersOf(graph, "c.ts")).toEqual(["a.ts", "b.ts"]);
    expect(importersOf(graph, "nowhere.ts")).toBeNull();
  });

  it("shows a clickable count that lists the importing files and opens one", async () => {
    const open = vi.fn();
    await mount("c.ts", Promise.resolve(graph), open);
    const chip = host.querySelector<HTMLElement>('[data-testid="imported-by"]');
    expect(chip?.textContent).toBe("Imported by 2 files");
    await act(async () => { chip?.click(); });
    const items = [...host.querySelectorAll<HTMLElement>('[role="listitem"]')];
    expect(items.map(i => i.textContent)).toEqual(["a.ts", "b.ts"]);
    await act(async () => { items[1]?.click(); });
    expect(open).toHaveBeenCalledWith("b.ts");
  });

  it("says no other files import a file with no importers, as plain text", async () => {
    await mount("lonely.ts", Promise.resolve(graph));
    const chip = host.querySelector('[data-testid="imported-by"]');
    expect(chip?.textContent).toBe("No other files import this");
    expect(chip?.tagName).toBe("SPAN");
  });

  it("hides when the file is not in the graph or the graph is unavailable", async () => {
    await mount("nowhere.ts", Promise.resolve(graph));
    expect(host.querySelector('[data-testid="imported-by"]')).toBeNull();
    await mount("c.ts", Promise.resolve({ error: "graph unavailable" }));
    expect(host.querySelector('[data-testid="imported-by"]')).toBeNull();
    await mount("c.ts", Promise.reject(new Error("x")));
    expect(host.querySelector('[data-testid="imported-by"]')).toBeNull();
  });
});
