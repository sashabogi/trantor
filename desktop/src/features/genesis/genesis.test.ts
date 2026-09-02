import { describe, expect, it } from "vitest";
import { genesisKickoff, projectTarget, slugProjectName } from "./genesis";

describe("genesis project helpers", () => {
  it("derives a CLI-safe slug and target under the development root", () => {
    const slug = slugProjectName("  New Client / Portal!  ");
    expect(slug).toBe("new-client-portal");
    expect(projectTarget("/Users/sasha/development/", slug)).toBe(
      "/Users/sasha/development/new-client-portal",
    );
  });

  it("points Claude at the durable brief instead of pasting it into the pane", () => {
    const brief = `${Array.from({ length: 400 }, (_, index) => `PRD line ${index + 1}`).join("\n")}\n`;
    const kickoff = genesisKickoff(brief, "client portal PRD.md");
    expect(kickoff).toBe(
      "Your brief is in CLAUDE.md (400 lines, dropped from client portal PRD.md). Read it, recap it in three sentences, and propose a plan.",
    );
    expect(kickoff.length).toBeLessThan(400);
    expect(kickoff).not.toContain("PRD line 1");
  });

  it("describes a typed brief without inventing a dropped filename", () => {
    expect(genesisKickoff("One line")).toBe(
      "Your brief is in CLAUDE.md (1 line, entered in the Genesis sheet). Read it, recap it in three sentences, and propose a plan.",
    );
  });
});
