// @vitest-environment happy-dom
// #14268: the Code screen's git calls leave a readable trail for the Output tab's Git channel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { clearGitLog, commandLabel, firstLines, formatGitEntry, gitLogEntries, loggedInvoke, parseExit } from "./gitLog";

beforeEach(() => { clearGitLog(); });
afterEach(() => { clearMocks(); });

describe("git log", () => {
  it("labels a command with its useful arguments and leaves the patch and scope out", () => {
    expect(commandLabel("git_branch_switch", { project: "p", scope: "project", name: "main", dirty: "ask" })).toBe("git branch switch main ask");
    expect(commandLabel("git_stage", { project: "p", agent: "a", paths: ["a.ts", "b.ts"], unstage: false })).toBe("git stage a.ts b.ts");
    expect(commandLabel("git_apply_patch", { path: "a.ts", patch: "HUGE", action: "stage" })).toBe("git apply patch a.ts stage");
  });

  it("keeps only the first lines of output", () => {
    expect(firstLines("a\n\nb\nc\nd")).toEqual(["a", "b", "c"]);
  });

  it("records a success with its output and a failure with its reason, and rethrows", async () => {
    mockIPC(command => {
      if (command === "git_push") throw new Error("rejected");
      return "pushed main";
    });
    await loggedInvoke("git_commit", { project: "p", message: "m" });
    await expect(loggedInvoke("git_push", { project: "p" })).rejects.toThrow();
    const [ok, bad] = gitLogEntries();
    expect(ok).toMatchObject({ command: "git commit m", ok: true, output: "pushed main" });
    expect(bad).toMatchObject({ command: "git push", ok: false });
    expect(formatGitEntry(ok)[0]).toMatch(/git commit m {2}ok \(\d+ ms\)$/);
  });

  it("does not log the routine panel poll when it succeeds, but does when it fails", async () => {
    mockIPC(() => "{}");
    await loggedInvoke("git_panel", { project: "p" });
    expect(gitLogEntries()).toHaveLength(0);
    mockIPC(() => { throw new Error("no repo"); });
    await expect(loggedInvoke("git_panel", { project: "p" })).rejects.toThrow();
    expect(gitLogEntries()).toHaveLength(1);
  });

  it("takes the exit code from the last line of a failure and times every call", async () => {
    mockIPC(() => { throw new Error("git push failed: fatal: no remote\nexit code 128"); });
    await expect(loggedInvoke("git_push", { project: "p" })).rejects.toThrow();
    const [bad] = gitLogEntries();
    expect(bad).toMatchObject({ ok: false, code: 128, output: "git push failed: fatal: no remote" });
    expect(bad.ms).toBeGreaterThanOrEqual(0);
    expect(formatGitEntry(bad)[0]).toMatch(/git push {2}failed \(exit 128, \d+ ms\)$/);
    expect(formatGitEntry(bad)[1]).toContain("fatal: no remote");
  });

  it("never invents a code: a failure without one shows only the time", async () => {
    mockIPC(() => { throw new Error("rejected"); });
    await expect(loggedInvoke("git_push", { project: "p" })).rejects.toThrow();
    const [bad] = gitLogEntries();
    expect(bad.code).toBeNull();
    expect(formatGitEntry(bad)[0]).toMatch(/failed \(\d+ ms\)$/);
    expect(parseExit("exit codes vary")).toEqual({ code: null, text: "exit codes vary" });
    expect(parseExit("boom\nexited with code 2")).toEqual({ code: 2, text: "boom" });
  });
});
