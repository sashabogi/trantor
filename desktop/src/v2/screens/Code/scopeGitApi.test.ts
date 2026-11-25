// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { scopeFetch, scopePull, scopePush, syncError } from "./scopeGitApi";

beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "developer" }); });
afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });

it.each([
  ["\n fatal: Remote is unavailable\nDetails", "Remote is unavailable"],
  ["error: Changes need attention\r\nDetails", "Changes need attention"],
  ["git push -u origin main failed: fatal: error: Remote is unavailable\nDetails", "Remote is unavailable"],
  ["git rebase origin/main failed: error: Changes need attention\nDetails", "Changes need attention"],
  ["Already a plain sentence", "Already a plain sentence"],
  ["  \n ", "Git sync failed"],
  ["fatal: ", "Git sync failed"],
  ["", "Git sync failed"],
])("cleans sync failure %s", (error, expected) => {
  expect(syncError(error)).toBe(expected);
});

it.each([
  ["git_fetch", scopeFetch],
  ["git_pull", scopePull],
  ["git_push", scopePush],
])("cleans %s failures and preserves the seat scope", async (command, action) => {
  const calls = vi.fn();
  mockIPC((name, args) => {
    calls(name, args);
    return Promise.reject("fatal: Remote is unavailable\nDetails");
  });
  await expect(action("acme", "seat-1")).rejects.toThrow("Remote is unavailable");
  expect(calls).toHaveBeenCalledWith(command, expect.objectContaining({ project: "acme", agent: "seat-1" }));
});
