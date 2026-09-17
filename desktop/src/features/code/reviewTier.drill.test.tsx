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
import { HubClient, type Card, type HubEvent, type OverseerStatus } from "../../shared/api/client";
import { Overseer } from "../overseer/Overseer";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

/** lib/core.ts with ten importers: the blast >= 10 case, and nothing else about it is risky. */
const TEN_DEPENDENTS: CodeGraph = {
  root: "/fixture-ten",
  nodes: [
    { id: "lib/core.ts", name: "core.ts", cluster: "lib", chars: 100, inDegree: 10, outDegree: 0, isTest: false, testedBy: 1, orphan: false, doc: false, cycleId: null, complexity: 0, todos: 0, churn: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `bin/cmd${i}.ts`, name: `cmd${i}.ts`, cluster: "bin", chars: 50, inDegree: 0, outDegree: 1, isTest: false, testedBy: 1, orphan: false, doc: false, cycleId: null, complexity: 0, todos: 0, churn: 0,
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

// The Overseer half of the drill: a project with open verify gates whose cards carry blast lines.
// The gate's card is the #<id> the claim cites, else the by-session's newest doing/testing card
// with a blast line, else nothing (the join the orchestrator ruled on #7971).

const STATUS: OverseerStatus = {
  engine: true, lastTickTs: Date.now(), tickMs: 5000, clearMs: 60000, dutySession: "claude:trantor-duty",
  watching: { sessions: 3, projects: 1, claims: 0, links: 0 }, autonomy: { "*": 1 }, links: [], warnings: [], standing: 0,
};

const GATES: HubEvent[] = [
  { id: 901, ts: 3000, type: "verify.gate.opened", project: "p", by: "kimi:p", claim: "#41 the hub keeps blast on the card event", sessions: ["kimi:p"] },
  { id: 902, ts: 2000, type: "verify.gate.opened", project: "p", by: "glm:p", claim: "the strip races the restore", sessions: ["glm:p"] },
  { id: 903, ts: 1000, type: "verify.gate.opened", project: "p", by: "codex:p", claim: "the box and the gate disagree", sessions: ["codex:p"] },
];

const CARDS: Card[] = [
  { id: 41, project: "p", title: "hub keeps blast", status: "testing", assignee: "kimi:p", updated: 10, log: [{ ts: 1, by: "kimi:p", text: "verified at abc1234\nblast: 12 files depend on the 2 changed" }] },
  { id: 52, project: "p", title: "older glm card", status: "doing", assignee: "glm:p", updated: 20, log: [{ ts: 1, by: "glm:p", text: "blast: 11 files depend on the 1 changed" }] },
  { id: 53, project: "p", title: "newest glm card", status: "testing", workedBy: "glm:p", updated: 30, log: [{ ts: 1, by: "glm:p", text: "verified at def5678\nblast: 3 files depend on the 1 changed" }] },
  { id: 60, project: "p", title: "codex card without a blast line", status: "doing", assignee: "codex:p", updated: 40, log: [{ ts: 1, by: "codex:p", text: "verified at 0123456" }] },
];

describe("S-review · the blast line on the Overseer gate card", () => {
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

  it("cites the claim's card at blast 12 with the careful chip, the by-session's newest card at 3 without it, and nothing for a card with no line", async () => {
    const cardReads: number[] = [];
    const stub: HubClient = Object.assign(Object.create(HubClient.prototype), {
      overseerStatus: async () => STATUS,
      health: async () => ({ ok: true, authMode: "enforce", peers: 0, messages: 0, streams: 0 }),
      economics: async () => { throw new Error("no ledger in the drill"); },
      events: async (opts: { type?: string }) => ({ events: opts.type === "verify.gate." ? GATES : [] }),
      peers: async () => [],
      proposals: async () => ({ proposals: [], pendingCount: 0 }),
      streamEvents: () => () => {},
      tasks: async (project?: string) => CARDS.filter(c => c.project === project).map(c => ({ ...c, log: undefined })),
      card: async (id: number) => { cardReads.push(id); return { task: CARDS.find(c => c.id === id) ?? null, events: [], messages: [] }; },
    });
    act(() => root.render(<Overseer client={stub} />));
    for (let i = 0; i < 8; i++) await flush();

    const cards = host.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length, "positive control: the three gates render").toBe(3);
    const lineOf = (i: number) => cards[i]?.querySelector<HTMLElement>('[data-testid="gate-blast"]');

    expect(lineOf(0)?.textContent).toContain("#41 · blast: 12 files depend on the 2 changed");
    expect(lineOf(0)?.querySelector('[data-testid="gate-careful"]')?.className).toContain("text-[var(--color-tr-warn)]");

    expect(lineOf(1)?.textContent).toContain("#53 · blast: 3 files depend on the 1 changed");
    expect(lineOf(1)?.querySelector('[data-testid="gate-careful"]')).toBeNull();

    expect(lineOf(2), "no join, no line").toBeNull();
    expect(cardReads).toEqual([41, 53, 60]);
    console.log(`  PASS  S-review · gate blast line  #41 -> "${lineOf(0)?.textContent}"; #53 -> "${lineOf(1)?.textContent}"; codex gate -> no line; card reads ${cardReads.join(",")}`);
  });
});
