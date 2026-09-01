import { describe, expect, it } from "vitest";
import { harnessLabel, sessionAge, sessionMatches, type SessionRow } from "./sessionsApi";

const row: SessionRow = {
  id: "s1",
  harness: "codex",
  title: "Build the Sessions mode",
  lastMessage: "The transcript decoder is green",
  messageCount: 12,
  model: "gpt-5.5",
  branch: "seat/codex",
  updatedAt: 1_000_000,
  cwd: "/Users/test/.agent-bus/worktrees/trantor/codex",
};

describe("session history presentation", () => {
  it("formats relative ages at the list's minute and hour boundaries", () => {
    expect(sessionAge(1_000_000, 1_020_000)).toBe("just now");
    expect(sessionAge(1_000_000, 1_120_000)).toBe("2m ago");
    expect(sessionAge(1_000_000, 8_200_000)).toBe("2h ago");
  });

  it("searches title, transcript preview, harness, model, branch, and cwd", () => {
    for (const query of ["sessions", "decoder", "codex", "gpt-5.5", "seat/codex", "worktrees"]) {
      expect(sessionMatches(row, query), query).toBe(true);
    }
    expect(sessionMatches(row, "claude-fable")).toBe(false);
  });

  it("uses explicit harness names", () => {
    expect(harnessLabel("claude")).toBe("Claude");
    expect(harnessLabel("opencode")).toBe("OpenCode");
    expect(harnessLabel("kimi")).toBe("Kimi");
  });
});
