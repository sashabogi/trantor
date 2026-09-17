// The tier table from Flare review.ts reproduced as cases (#7971 drill, blueprint §5 card 5),
// the dependents walk over the six-node fixture, and the blast line read back off a card note.
import { describe, expect, it } from "vitest";
import { SIX_NODE_GRAPH } from "./graph/fixture";
import { blastFromLog, blastText, blastTier, chipText, claimCardId, dependentsOf, fallbackCandidates, fileReview, parseBlastLine, reviewTier, uncovered, type TierInput } from "./reviewTier";

const input = (over: Partial<TierInput> = {}): TierInput => ({
  path: "lib/x.ts",
  risk: 0,
  blastRadius: 0,
  fanIn: 0,
  coveragePct: null,
  testedBy: 1,
  complexity: 0,
  inCycle: false,
  isTest: false,
  ...over,
});

describe("reviewTier · the tier table", () => {
  it("blast 10 is careful, with the count as the reason", () => {
    const r = reviewTier(input({ blastRadius: 10, fanIn: 4 }));
    expect(r.tier).toBe("careful");
    expect(r.reasons).toEqual(["10 files break if this is wrong"]);
  });

  it("blast 3 is read", () => {
    const r = reviewTier(input({ blastRadius: 3, fanIn: 2 }));
    expect(r.tier).toBe("read");
    expect(r.reasons).toEqual(["3 files break if this is wrong"]);
  });

  it("a test file nothing depends on is skim with the test reason", () => {
    const r = reviewTier(input({ isTest: true }));
    expect(r.tier).toBe("skim");
    expect(r.reasons).toEqual(["a test, the suite checks it for you"]);
  });

  it("a leaf nothing imports is skim with the leaf reason", () => {
    expect(reviewTier(input()).reasons).toEqual(["nothing depends on it yet"]);
  });

  it("risk, cycle-with-importer and uncovered-with-fan-in each reach careful", () => {
    expect(reviewTier(input({ risk: 60 })).tier).toBe("careful");
    expect(reviewTier(input({ inCycle: true, fanIn: 1 })).tier).toBe("careful");
    expect(reviewTier(input({ inCycle: true })).tier).toBe("skim");
    expect(reviewTier(input({ testedBy: 0, fanIn: 3 })).tier).toBe("careful");
    expect(reviewTier(input({ coveragePct: 80, fanIn: 3 })).tier).toBe("read");
  });

  it("risk 30, complexity 40 and fan-in 3 each reach read", () => {
    expect(reviewTier(input({ risk: 30 })).tier).toBe("read");
    expect(reviewTier(input({ complexity: 40 })).tier).toBe("read");
    expect(reviewTier(input({ fanIn: 3 })).tier).toBe("read");
    expect(reviewTier(input({ fanIn: 2 })).tier).toBe("skim");
  });

  it("coverage null falls back to testedBy; a measured figure under 30 is uncovered", () => {
    expect(uncovered(input({ coveragePct: null, testedBy: 0 }))).toBe(true);
    expect(uncovered(input({ coveragePct: null, testedBy: 2 }))).toBe(false);
    expect(uncovered(input({ coveragePct: 29 }))).toBe(true);
    expect(uncovered(input({ coveragePct: 30 }))).toBe(false);
    expect(reviewTier(input({ coveragePct: 12 })).reasons).toEqual(["only 12% covered"]);
  });
});

describe("fileReview · one file off code_graph", () => {
  it("walks transitive dependents, never counting the file itself through its cycle", () => {
    expect([...dependentsOf(SIX_NODE_GRAPH, "lib/a.ts")].sort()).toEqual(["bin/cli.ts", "lib/b.ts", "test/a.test.ts"]);
    expect([...dependentsOf(SIX_NODE_GRAPH, "lib/b.ts")].sort()).toEqual(["bin/cli.ts", "lib/a.ts", "test/a.test.ts"]);
    expect(dependentsOf(SIX_NODE_GRAPH, "lib/stray.ts").size).toBe(0);
  });

  it("lib/a.ts sits in a cycle with importers: careful, three dependents", () => {
    const r = fileReview(SIX_NODE_GRAPH, "lib/a.ts");
    expect(r).toMatchObject({ tier: "careful", dependents: 3 });
    expect(chipText(r)).toBe("careful · 3 dependents");
  });

  it("the fixture's test file is skim with the test reason, never uncovered", () => {
    const r = fileReview(SIX_NODE_GRAPH, "test/a.test.ts");
    expect(r).toMatchObject({ tier: "skim", dependents: 0, reasons: ["a test, the suite checks it for you"] });
  });

  it("the orphan is skim with zero dependents, said as zero", () => {
    expect(chipText(fileReview(SIX_NODE_GRAPH, "lib/stray.ts"))).toBe("skim · 0 dependents");
  });

  it("a path the graph has no node for is not in the graph, never a silent zero", () => {
    const r = fileReview(SIX_NODE_GRAPH, "package.json");
    expect(r).toEqual({ notInGraph: true });
    expect(chipText(r)).toBe("not in the graph");
  });
});

describe("parseBlastLine · the note line hollow-move.mjs writes", () => {
  it("reads the measured line, with and without unindexed paths", () => {
    expect(parseBlastLine("verified at abc1234\nblast: 7 files depend on the 3 changed")).toEqual({ kind: "measured", dependents: 7, changed: 3, unindexed: [] });
    expect(parseBlastLine("blast: 1 file depends on the 1 changed (package.json, tauri.conf.json not in the graph)"))
      .toEqual({ kind: "measured", dependents: 1, changed: 1, unindexed: ["package.json", "tauri.conf.json"] });
  });

  it("reads the three non-answers and takes the last blast line of a note", () => {
    expect(parseBlastLine("blast: not in the graph (package.json)")).toEqual({ kind: "not-in-graph", unindexed: ["package.json"] });
    expect(parseBlastLine("blast: no committed changes since 3a26730")).toEqual({ kind: "no-changes", base: "3a26730" });
    expect(parseBlastLine("blast: unavailable")).toEqual({ kind: "unavailable" });
    expect(parseBlastLine("blast: unavailable\nlater\nblast: 12 files depend on the 2 changed")).toMatchObject({ kind: "measured", dependents: 12 });
    expect(parseBlastLine("verified at abc1234, nothing measured")).toBeNull();
  });

  it("the gate's tier from the count alone: careful at 10, read at 3, skim under, null unmeasured", () => {
    expect(blastTier({ kind: "measured", dependents: 10, changed: 1, unindexed: [] })).toBe("careful");
    expect(blastTier({ kind: "measured", dependents: 3, changed: 1, unindexed: [] })).toBe("read");
    expect(blastTier({ kind: "measured", dependents: 2, changed: 1, unindexed: [] })).toBe("skim");
    expect(blastTier({ kind: "unavailable" })).toBeNull();
  });
});

describe("the gate's card · the join the orchestrator ruled on #7971", () => {
  it("takes the first #<id> the claim cites, and none when it cites nothing", () => {
    expect(claimCardId("#7968 gated clean and cherry-picked")).toBe(7968);
    expect(claimCardId("see #50 then #7")).toBe(50);
    expect(claimCardId("the hub keeps blast")).toBeNull();
  });

  it("falls back to the opening session's newest doing/testing card in the project", () => {
    const cards = [
      { id: 1, project: "p", status: "doing", assignee: "kimi:p", updated: 10 },
      { id: 2, project: "p", status: "testing", workedBy: "kimi:p", updated: 30 },
      { id: 3, project: "p", status: "done", assignee: "kimi:p", updated: 40 },
      { id: 4, project: "q", status: "doing", assignee: "kimi:p", updated: 50 },
      { id: 5, project: "p", status: "doing", assignee: "glm:p", updated: 60 },
    ];
    expect(fallbackCandidates("kimi:p", "p", cards).map(c => c.id)).toEqual([2, 1]);
    expect(fallbackCandidates("", "p", cards)).toEqual([]);
  });

  it("reads the newest blast line off a log and words it back as hollow-move did", () => {
    const log = [
      { text: "verified at abc1234\nblast: unavailable" },
      { text: "no blast here" },
      { text: "verified at def5678\nblast: 12 files depend on the 2 changed (package.json not in the graph)" },
    ];
    const note = blastFromLog(log);
    expect(note).toMatchObject({ kind: "measured", dependents: 12 });
    expect(note && blastText(note)).toBe("blast: 12 files depend on the 2 changed (package.json not in the graph)");
    expect(blastFromLog([{ text: "verified at abc1234" }])).toBeNull();
    expect(blastText({ kind: "not-in-graph", unindexed: ["package.json"] })).toBe("blast: not in the graph (package.json)");
    expect(blastText({ kind: "no-changes", base: "3a26730" })).toBe("blast: no committed changes since 3a26730");
    expect(blastText({ kind: "measured", dependents: 1, changed: 1, unindexed: [] })).toBe("blast: 1 file depends on the 1 changed");
  });
});
