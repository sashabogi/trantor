// @vitest-environment happy-dom
// The #7977 app drill in drill-surface form: a seat's file.claim on lib/a.ts colours that card
// unread under the Unread lens (the before-count is the positive control), opening it from the
// graph clears it, and the Home stat over the same events drops by one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphView } from "../GraphView";
import type { GraphApi } from "./graphApi";
import type { FileEvent } from "./unread";
import { SIX_NODE_GRAPH } from "./fixture";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const T1 = 2_000;

const fakeApi = (events: FileEvent[]): GraphApi => ({
  graph: async () => SIX_NODE_GRAPH,
  changes: async () => [],
  fileChanges: () => () => {},
  fileEvents: async () => events,
});

describe("S-unread · the Unread lens on the graph view", () => {
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

  const lensTab = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="graph-lens"] button')].find(b => b.textContent === "unread");
  const card = (id: string) => host.querySelector<HTMLButtonElement>(`[data-graph-node="${id}"]`);
  const count = () => host.querySelector('[data-testid="graph-unread-count"]')?.textContent ?? null;

  it("a claimed, unopened file is unread; opening it from the graph clears it", async () => {
    const opened: string[] = [];
    const events: FileEvent[] = [{ type: "file.claim", ts: T1, file: "lib/a.ts", project: "p" }];
    act(() => root.render(<GraphView project="p" seat={null} onOpen={p => opened.push(p)} api={fakeApi(events)} />));
    await flush();

    expect(count(), "no count outside the Unread lens").toBeNull();
    act(() => lensTab()?.click());
    expect(count()).toBe("1 unread");
    expect(host.querySelector('[data-testid="graph-legend"]')?.textContent).toContain("changed, not read");
    expect(card("@dir:lib")?.dataset.graphTone, "the collapsed lib card carries its member's state").toBe("unread");
    expect(card("@dir:bin")?.dataset.graphTone).toBe("calm");
    evidence.push(`before: ${count()}, @dir:lib tone=${card("@dir:lib")?.dataset.graphTone}`);

    act(() => card("@dir:lib")?.click());
    const a = card("lib/a.ts");
    expect(a?.dataset.graphTone).toBe("unread");
    expect(a?.style.borderColor).toBe("var(--color-tr-fail)");
    expect(card("lib/b.ts")?.dataset.graphTone).toBe("calm");

    act(() => a?.click());
    expect(opened).toEqual(["lib/a.ts"]);
    expect(count()).toBe("0 unread");
    expect(card("lib/a.ts")?.dataset.graphTone).not.toBe("unread");
    evidence.push(`after open: ${count()}, opened=${opened.join(",")}`);
  });

  it("a read before the claim is unread again; a read after it is read", async () => {
    const events: FileEvent[] = [
      { type: "file.read", ts: T1 - 1, file: "lib/a.ts", project: "p" },
      { type: "file.claim", ts: T1, file: "lib/a.ts", project: "p" },
      { type: "file.claim", ts: T1, file: "lib/b.ts", project: "p" },
      { type: "file.read", ts: T1 + 1, file: "lib/b.ts", project: "p" },
    ];
    act(() => root.render(<GraphView project="p" seat={null} onOpen={() => {}} api={fakeApi(events)} />));
    await flush();
    act(() => lensTab()?.click());
    act(() => card("@dir:lib")?.click());
    expect(count()).toBe("1 unread");
    expect(card("lib/a.ts")?.dataset.graphTone).toBe("unread");
    expect(card("lib/b.ts")?.dataset.graphTone).toBe("read");
    expect(card("lib/b.ts")?.style.borderColor).toBe("var(--color-tr-ok)");
    evidence.push(`a=unread b=read count=${count()}`);
  });

  it("a fresh repo with no events has nothing unread", async () => {
    act(() => root.render(<GraphView project="p" seat={null} onOpen={() => {}} api={fakeApi([])} />));
    await flush();
    act(() => lensTab()?.click());
    expect(count()).toBe("0 unread");
    expect([...host.querySelectorAll<HTMLElement>("[data-graph-node]")].every(n => n.dataset.graphTone === "calm")).toBe(true);
    console.log(`PASS S-unread · ${evidence.join(" | ")}`);
  });
});
