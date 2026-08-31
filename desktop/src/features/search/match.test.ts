// #5625 — one search vocabulary, drilled: text, #id, @assignee; projects prefix-first;
// the palette list caps and scopes.
import { describe, expect, it } from "vitest";
import type { Card, HubEvent } from "../../shared/api/client";
import { eventLabel, matchesCard, matchProjects, paletteHits } from "./match";

const card = (id: number, title: string, assignee?: string): Card =>
  ({ id, project: "p", title, status: "todo", assignee });
const event = (type: string, fields: Partial<HubEvent>): HubEvent =>
  ({ type, ts: 10, project: "trantor", ...fields });

describe("matchesCard", () => {
  it("speaks the board's vocabulary", () => {
    expect(matchesCard(card(5570, "Balance bar"), "#55")).toBe(true);
    expect(matchesCard(card(4400, "Balance bar"), "#55")).toBe(false);
    expect(matchesCard(card(1, "x", "MacBook-Pro-M1:trantor"), "@macbook")).toBe(true);
    expect(matchesCard(card(1, "Orca-standard footer"), "orca")).toBe(true);
    expect(matchesCard(card(1, "nothing here"), "orca")).toBe(false);
    expect(matchesCard(card(1, "anything"), "  ")).toBe(true);
  });
});

describe("matchProjects", () => {
  const ps = ["trantor", "crebral-health", "crebral-scribe", "agent-router"];
  it("prefix beats containment, capped, and #/@ queries are never projects", () => {
    expect(matchProjects(ps, "tr")[0]).toBe("trantor");
    expect(matchProjects(ps, "cre")).toEqual(["crebral-health", "crebral-scribe"]);
    expect(matchProjects(ps, "#12")).toEqual([]);
    expect(matchProjects(ps, "@x")).toEqual([]);
    expect(matchProjects(ps, "")).toEqual([]);
  });
});

describe("paletteHits", () => {
  const cardsBy = { trantor: [card(5570, "Balance bar"), card(5593, "Record rail")], other: [card(9, "balance elsewhere")] };
  it("global: projects lead, then cards across the set", () => {
    const hits = paletteHits("balance", ["trantor", "other"], cardsBy, { includeProjects: true });
    expect(hits.some(h => h.kind === "card" && h.project === "other")).toBe(true);
    expect(hits.filter(h => h.kind === "card").length).toBe(2);
  });
  it("global: exact project/prefix rows rank before card rows", () => {
    const hits = paletteHits("trantor", ["trantor"], { trantor: [card(1, "trantor cleanup")] }, { includeProjects: true });
    expect(hits[0]).toEqual({ kind: "project", project: "trantor" });
    expect(hits[1]?.kind).toBe("card");
  });
  it("project scope: no project rows, cards only", () => {
    const hits = paletteHits("rec", ["trantor"], { trantor: cardsBy.trantor }, { includeProjects: false });
    expect(hits).toEqual([{ kind: "card", project: "trantor", card: cardsBy.trantor[1] }]);
  });
  it("includes messages, events, and files as distinct result kinds", () => {
    const hits = paletteHits("needle", [], {}, { includeProjects: false }, {
      messagesByProject: { trantor: [event("message", { id: 1, text: "needle in the bus", by: "codex:trantor" })] },
      eventsByProject: { trantor: [event("file.claim", { id: 2, file: "desktop/src/features/search/Palette.tsx" })] },
      filesByProject: { trantor: ["desktop/src/features/search/needle.ts"] },
    });
    expect(hits.map(h => h.kind)).toEqual(["message", "file"]);

    const eventHits = paletteHits("palette", [], {}, { includeProjects: false }, {
      eventsByProject: { trantor: [event("file.claim", { id: 3, file: "desktop/src/features/search/Palette.tsx" })] },
    });
    expect(eventHits.map(h => h.kind)).toEqual(["event"]);
  });
  it("#card references in messages open the card", () => {
    const [hit] = paletteHits("reported", [], {}, { includeProjects: false }, {
      messagesByProject: { trantor: [event("message", { id: 4, text: "reported #5628 ready" })] },
    });
    expect(hit).toMatchObject({ kind: "message", cardId: 5628 });
  });
  it("empty query in project scope lists nothing — type to search, never a dump", () => {
    expect(paletteHits("", ["trantor"], cardsBy, { includeProjects: false })).toEqual([]);
  });
  it("caps the list — a dropdown is a glance, not a page", () => {
    const many = { p: Array.from({ length: 40 }, (_, i) => card(i + 1, `hit ${i}`)) };
    expect(paletteHits("hit", [], many, { includeProjects: false }).length).toBe(12);
  });
});

describe("eventLabel", () => {
  it("labels event rows from their useful fields", () => {
    expect(eventLabel(event("moved", { taskId: 5628, from: "doing", to: "testing", title: "Search v2" })))
      .toContain("#5628 doing -> testing");
    expect(eventLabel(event("verify.gate.opened", { claim: "check the gate" }))).toContain("check the gate");
  });
});
