// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ConflictView } from "./ConflictView";
import { saveMode } from "../../shell/shellMode";
import type { ScopeSnapshot } from "./useScopeGit";
import type { GitOperation } from "./scopeGitApi";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = { project?: string; scope?: string; seat?: string | null; path?: string; text?: string; paths?: string[]; unstage?: boolean };
let host: HTMLDivElement;
let root: Root;
let calls: { command: string; args: Args }[] = [];
let operation: GitOperation;

beforeEach(() => {
  calls = [];
  operation = { operation: null, conflicts: 0 };
  saveMode("developer");
  mockIPC((command, raw) => {
    // SAFETY: every mocked invoke uses this command's named argument object.
    const args = (raw ?? {}) as Args;
    calls.push({ command, args });
    if (command === "read_file") return JSON.stringify({ text: "<<<<<<< HEAD\nmain\n=======\ntopic\n>>>>>>> topic\n", truncated: false, bytes: 50 });
    if (command === "git_operation") return JSON.stringify(operation);
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); saveMode("orchestrator"); vi.unstubAllGlobals(); });

it("resolves and stages a conflict on the project checkout", async () => {
  const snap: ScopeSnapshot = {
    scope: null, branch: "main", upstream: null, ahead: 0, behind: 0,
    status: [{ path: "a.txt", x: "U", y: "U" }], counts: [], log: [], seatBacked: false, readAt: Date.now(),
  };
  await act(async () => { root.render(<ConflictView project="trantor" snap={snap} path="a.txt" onPick={() => undefined} onResolved={() => undefined} />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => {
    [...host.querySelectorAll("button")].find(button => button.textContent === "Take current")?.click();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(calls.find(call => call.command === "read_file")?.args).toMatchObject({ path: "a.txt", seat: null });
  expect(calls.find(call => call.command === "file_write_plain")?.args).toMatchObject({ path: "a.txt", seat: null, text: "main\n" });
  expect(calls.find(call => call.command === "git_stage")?.args).toEqual({ project: "trantor", scope: "project", paths: ["a.txt"], unstage: false });
});

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const resolvedSnap = (): ScopeSnapshot => ({
  scope: null, branch: "main", upstream: null, ahead: 0, behind: 0,
  status: [], counts: [], log: [], seatBacked: false, readAt: Date.now(),
});
const findButton = (text: string) => [...host.querySelectorAll("button")].find(button => button.textContent === text);

it("continues a paused merge once no conflicted files remain", async () => {
  operation = { operation: "merge", conflicts: 0 };
  const onResolved = vi.fn();
  await act(async () => { root.render(<ConflictView project="trantor" snap={resolvedSnap()} path={null} onPick={() => undefined} onResolved={onResolved} />); });
  await flush();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Merge paused");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("0 conflicted files");
  await act(async () => { findButton("Continue")?.click(); });
  await flush();
  expect(calls.find(call => call.command === "git_operation_continue")?.args).toEqual({ project: "trantor", scope: "project" });
  expect(onResolved).toHaveBeenCalledTimes(1);
});

it("asks before aborting a paused merge", async () => {
  operation = { operation: "merge", conflicts: 0 };
  await act(async () => { root.render(<ConflictView project="trantor" snap={resolvedSnap()} path={null} onPick={() => undefined} onResolved={() => undefined} />); });
  await flush();
  await act(async () => { findButton("Abort…")?.click(); });
  await flush();
  expect(calls.some(call => call.command === "git_operation_abort")).toBe(false);
  expect(host.textContent).toContain("Abort this merge and discard its conflict resolutions?");
  await act(async () => { findButton("Confirm abort")?.click(); });
  await flush();
  expect(calls.find(call => call.command === "git_operation_abort")?.args).toEqual({ project: "trantor", scope: "project" });
});

it("keeps the abort question open when git is read again while the merge is still paused", async () => {
  operation = { operation: "merge", conflicts: 0 };
  const view = (readAt: number) => <ConflictView project="trantor" snap={{ ...resolvedSnap(), readAt }} path={null} onPick={() => undefined} onResolved={() => undefined} />;
  await act(async () => { root.render(view(1)); });
  await flush();
  await act(async () => { findButton("Abort…")?.click(); });
  await flush();
  await act(async () => { root.render(view(2)); });
  await flush();
  expect(findButton("Confirm abort")).toBeDefined();
  expect(calls.some(call => call.command === "git_operation_abort")).toBe(false);
});
