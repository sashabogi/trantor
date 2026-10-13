// @vitest-environment happy-dom
// The Graph lens (#11597): the top-level surface mounts the REUSED GraphView (cluster cards from
// the S-graph fixture), a file card click hands the path to the Code lens, and the scope picker
// offers the project plus this project's seats — MacBook rows and other projects filtered out.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubClient } from "../../../shared/api/client";
import { GraphLens } from "./GraphLens";
import type { GraphApi } from "./graphApi";
import { SIX_NODE_CLUSTERS, SIX_NODE_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const fakeApi = (): GraphApi => ({
  graph: async () => SIX_NODE_GRAPH,
  changes: async () => [],
  fileChanges: () => () => {},
});

const stubClient = (sessions: string[]): HubClient => Object.assign(Object.create(HubClient.prototype), {
  peers: async () => sessions.map(session => ({ session, online: true })),
});

const renderLens = (root: Root, over: {
  onSeat?: (s: string | null) => void; onOpenFile?: (p: string) => void;
} = {}) => {
  const picked: (string | null)[] = [];
  const opened: string[] = [];
  act(() => root.render(
    <GraphLens
      client={stubClient(["kimi:p", "glm:p", "MacBook-Pro-M1:p", "kimi:other"])}
      project="p" lens="graph"
      onLens={() => {}}
      seat={null}
      onSeat={over.onSeat ?? (s => picked.push(s))}
      onOpenFile={over.onOpenFile ?? (p => opened.push(p))}
      api={fakeApi()}
    />,
  ));
  return { picked, opened };
};

describe("GraphLens · the graph as its own top-level lens", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mounts the reused GraphView: header tabs, cluster cards, canvas", async () => {
    renderLens(root);
    await flush();
    await flush();

    expect(host.querySelector('[data-testid="graph-view"]'), "GraphView itself mounted, not a fork").not.toBeNull();
    const cards = [...host.querySelectorAll<HTMLButtonElement>("[data-graph-node]")];
    expect(cards.length, "cluster zoom: one card per top-level directory with code").toBe(SIX_NODE_CLUSTERS.length);
    expect([...cards].every(c => c.dataset.graphKind === "cluster")).toBe(true);
    expect(host.querySelector('[data-testid="graph-meta"]')?.textContent).toContain("6 files · 4 edges · 4 clusters");
    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".tr-seg > button")].map(b => b.textContent);
    expect(tabs, "the lens's own header carries the six tabs").toContain("Graph");
  });

  it("clicking a file card hands the path to the Code lens", async () => {
    const { opened } = renderLens(root);
    await flush();
    await flush();

    act(() => host.querySelector<HTMLButtonElement>('[data-graph-node="@dir:lib"]')?.click());
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('[data-graph-node="lib/a.ts"]')?.click());
    expect(opened, "the same open-into-Code the in-Code graph tab answers").toEqual(["lib/a.ts"]);
  });

  it("the scope picker offers the project and this project's seats only", async () => {
    const { picked } = renderLens(root);
    await flush();

    const chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="graph-scope"] > button')];
    expect(chips.map(b => b.textContent)).toEqual(["project", "seat/kimi", "seat/glm"]);
    expect(chips[0].dataset.on, "project scope by default").toBe("true");
    act(() => chips.find(b => b.textContent === "seat/kimi")?.click());
    expect(picked).toEqual(["kimi"]);
  });
});
