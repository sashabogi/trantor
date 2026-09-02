import { describe, expect, it } from "vitest";
import { GENESIS_RECAP_LINE, genesisKickoff, projectTarget, slugProjectName } from "./genesis";

describe("genesis project helpers", () => {
  it("derives a CLI-safe slug and target under the development root", () => {
    const slug = slugProjectName("  New Client / Portal!  ");
    expect(slug).toBe("new-client-portal");
    expect(projectTarget("/Users/sasha/development/", slug)).toBe(
      "/Users/sasha/development/new-client-portal",
    );
  });

  it("keeps the brief verbatim and appends one kickoff line", () => {
    const brief = "First line\n\n- Keep this exact spacing\n";
    expect(genesisKickoff(brief)).toBe(`${brief}${GENESIS_RECAP_LINE}`);
    expect(genesisKickoff("")).toBe(GENESIS_RECAP_LINE);
  });
});
