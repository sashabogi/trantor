// @vitest-environment happy-dom
// The lens tabs (#11597): the header renders SIX lenses, Graph seated between Code and Board —
// the order the operator reads left to right, so a rename or re-seat here is a contract break.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectHeader } from "./ProjectHeader";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectHeader · the six lenses", () => {
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

  it("renders workspace, code, graph, board, feed, bus in order, raising the active one", () => {
    const chosen: string[] = [];
    act(() => root.render(
      <div>
        <ProjectHeader project="trantor" sub={null} lens="graph" onLens={l => chosen.push(l)} />
      </div>,
    ));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".tr-seg > button")];
    expect(tabs.map(b => b.textContent)).toEqual(["Workspace", "Code", "Graph", "Board", "Feed", "Bus"]);
    expect(tabs.find(b => b.textContent === "Graph")?.dataset.on).toBe("true");
    act(() => tabs.find(b => b.textContent === "Board")?.click());
    expect(chosen).toEqual(["board"]);
  });
});
