import { describe, expect, it } from "vitest";
import { BLANK_KICKOFF } from "./genesisFlow";
import { PLAIN_WAKE_KICKOFF } from "./genesis";
import { hasBuildCards, isReviewCard, wakeKickoffFor } from "./wakeKickoff";

describe("wakeKickoff (#6120)", () => {
  it("counts open todo/doing/testing cards as build cards", () => {
    expect(hasBuildCards([{ title: "P1 build the parser", status: "todo" }])).toBe(true);
    expect(hasBuildCards([{ title: "P1 build the parser", status: "doing" }])).toBe(true);
    expect(hasBuildCards([{ title: "P1 build the parser", status: "testing" }])).toBe(true);
  });

  it("never counts the PRD-review card itself, or closed work", () => {
    // If the review card counted as build work, a project whose review already convened would
    // look un-reviewed and every wake would re-convene it.
    expect(hasBuildCards([{ title: "PRD review: pr-os", status: "doing" }])).toBe(false);
    expect(hasBuildCards([{ title: "prd-review rubric dispatch", status: "todo" }])).toBe(false);
    expect(hasBuildCards([{ title: "P1 build the parser", status: "done" }])).toBe(false);
    expect(hasBuildCards([])).toBe(false);
  });

  it("isReviewCard reads the title, not the assignee", () => {
    expect(isReviewCard({ title: "PRD Review — crew consensus" })).toBe(true);
    expect(isReviewCard({ title: "P1 build the parser" })).toBe(false);
  });

  it("a brief with no build cards takes the review kickoff; everything else the plain wake", () => {
    expect(wakeKickoffFor({ prd: true, buildCards: false })).not.toBe(PLAIN_WAKE_KICKOFF);
    expect(wakeKickoffFor({ prd: true, buildCards: true })).toBe(PLAIN_WAKE_KICKOFF);
    expect(wakeKickoffFor({ prd: false, buildCards: false })).toBe(PLAIN_WAKE_KICKOFF);
  });

  it("the review kickoff convenes the review instead of recapping", () => {
    const kickoff = wakeKickoffFor({ prd: true, buildCards: false });
    expect(kickoff).toMatch(/docs\/PRD\.md/);
    expect(kickoff).toMatch(/review/i);
    expect(kickoff).not.toMatch(/recap/i);
  });
});

describe("BLANK_KICKOFF (#6120)", () => {
  it("says the project is empty and asks what to build", () => {
    expect(BLANK_KICKOFF).toMatch(/empty/i);
    expect(BLANK_KICKOFF).toMatch(/ask .*what to build/i);
  });

  it("carries neither recap nor review wording — those are the other two entries", () => {
    expect(BLANK_KICKOFF).not.toMatch(/recap|review|PRD/i);
    expect(BLANK_KICKOFF).not.toBe(PLAIN_WAKE_KICKOFF);
  });
});
