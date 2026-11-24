import { describe, expect, it } from "vitest";
import { harnessLabel, parseSessionsListing, sessionAge, sessionMatches, storeLabel, type SessionRow } from "./sessionsApi";

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

  it("reads the listing with per-store warnings, and the older bare array (#13987 drill)", () => {
    const listing = parseSessionsListing(JSON.stringify({ sessions: [row], warnings: [{ store: "opencode", message: "file is not a database" }] }));
    expect(listing.sessions.map(s => s.id)).toEqual(["s1"]);
    expect(listing.warnings).toEqual([{ store: "opencode", message: "file is not a database" }]);
    expect(parseSessionsListing("[]")).toEqual({ sessions: [], warnings: [] });
    expect(storeLabel("opencode")).toBe("OpenCode");
    expect(storeLabel("files")).toBe("files");
  });

  it("uses explicit harness names", () => {
    expect(harnessLabel("claude")).toBe("Claude");
    expect(harnessLabel("opencode")).toBe("OpenCode");
    expect(harnessLabel("kimi")).toBe("Kimi");
  });
});
