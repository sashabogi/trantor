import { describe, expect, it } from "vitest";
import {
  PLAIN_WAKE_KICKOFF,
  PRD_REVIEW_KICKOFF,
  genesisKickoff,
  projectTarget,
  slugProjectName,
} from "./genesis";

describe("genesis project helpers", () => {
  it("derives a CLI-safe slug and target under the development root", () => {
    const slug = slugProjectName("  New Client / Portal!  ");
    expect(slug).toBe("new-client-portal");
    expect(projectTarget("/Users/sasha/development/", slug)).toBe(
      "/Users/sasha/development/new-client-portal",
    );
  });

  it("a brief falls back to the PRD review entry point, never to the brief itself", () => {
    const brief = `${Array.from({ length: 400 }, (_, index) => `PRD line ${index + 1}`).join("\n")}\n`;
    const kickoff = genesisKickoff(brief, "client portal PRD.md");
    expect(kickoff).toBe(PRD_REVIEW_KICKOFF);
    expect(kickoff).toBe("docs/PRD.md is the brief; run /trantor:prd-review");
    expect(kickoff.length).toBeLessThan(400);
    expect(kickoff).not.toContain("PRD line 1");
  });

  it("a typed one-line brief takes the same review entry point", () => {
    expect(genesisKickoff("One line")).toBe(PRD_REVIEW_KICKOFF);
  });

  it("no brief falls back to the plain wake: a blank project has nothing to review", () => {
    expect(genesisKickoff("")).toBe(PLAIN_WAKE_KICKOFF);
    expect(genesisKickoff("  \n")).toBe(PLAIN_WAKE_KICKOFF);
  });
});
