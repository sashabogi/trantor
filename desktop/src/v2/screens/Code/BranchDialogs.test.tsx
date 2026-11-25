// @vitest-environment happy-dom
// #14268: a branch dialog closes on Escape, and the rename box takes Enter.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BranchDialogs } from "./BranchDialogs";
import type { GitBranch } from "./scopeGitApi";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const branch: GitBranch = { name: "feature", sha: "abc1234", committed_at: 0, ahead: 0, behind: 0, current: false, remote: false, worktree: null };
let host: HTMLDivElement;
let root: Root;
const dismiss = vi.fn();
const rename = vi.fn();
beforeEach(() => {
  dismiss.mockClear(); rename.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = (dialog: Parameters<typeof BranchDialogs>[0]["dialog"]) => act(async () => {
  root.render(<BranchDialogs dialog={dialog} project="trantor" scope={null} statusCount={2} busy={false} onDismiss={dismiss}
    onCreated={() => undefined} onError={() => undefined} onSwitch={() => undefined} onRename={rename} onDelete={() => undefined} />);
});

it("offers Stash and switch, Bring changes and Cancel for a dirty switch, and Escape cancels", async () => {
  await mount({ kind: "switch", branch });
  const labels = [...host.querySelectorAll("button")].map(b => b.textContent);
  expect(labels).toEqual(["Cancel", "Stash and switch", "Bring changes"]);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("Enter in the rename box renames to the typed name", async () => {
  await mount({ kind: "rename", branch });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "feature-2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(rename).toHaveBeenCalledWith("feature", "feature-2");
});
