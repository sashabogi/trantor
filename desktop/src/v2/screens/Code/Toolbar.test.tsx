// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Toolbar } from "./Toolbar";
import { useScopeGit } from "./useScopeGit";
import { MODE_KEY } from "../../shell/shellMode";

// #14268: React needs its test flag to flush the snapshot and sync responses in this fixture.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let remote: string | null;
let ahead: number;
let complete: (value: string | undefined) => void;
let fail: (error: string | Error) => void;
const onError = vi.fn();
const onMutated = vi.fn();
const ipc = vi.fn();

function Fixture({ scope = null }: { scope?: string | null }) {
  const { state } = useScopeGit("acme", scope);
  return <Toolbar project="acme" scope={scope} snap={state.kind === "ok" ? state.snap : null} seats={[]}
    acts={{ onCheckout: vi.fn(), onSeat: vi.fn(), onCompare: vi.fn(), onMessage: vi.fn(), onCopy: vi.fn() }} view="changes" onView={vi.fn()}
    onMutated={onMutated} onError={onError} onOpenConflict={vi.fn()} />;
}

beforeEach(() => {
  remote = "upstream";
  ahead = 2;
  vi.clearAllMocks();
  const values = new Map([[MODE_KEY, "developer"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  mockIPC((command, args) => {
    ipc(command, args);
    if (command === "git_panel") return JSON.stringify({ branch: "main", upstream: null, remote, ahead, behind: null, status: [], counts: [], log: [] });
    return new Promise<string | undefined>((resolve, reject) => { complete = resolve; fail = reject; });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });
const mount = async (scope: string | null = null) => { await act(async () => { root.render(<Fixture scope={scope} />); }); };
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(element => element.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
const click = async (label: string) => { await act(async () => { button(label).click(); }); };

it.each([null, "seat-1"])("disables every sync action without a remote for scope %s", async scope => {
  remote = null;
  localStorage.setItem(MODE_KEY, "orchestrator");
  await mount(scope);
  expect(button("Sync").title).toBe("This repository has no remote");
  await click("Sync");
  for (const label of ["Fetch", "Pull", "Push ↑2"]) {
    expect(button(label).disabled).toBe(true);
    expect(button(label).title).toBe("This repository has no remote");
    await click(label);
  }
  expect(ipc.mock.calls.every(([command]) => command === "git_panel")).toBe(true);
  expect(onError).not.toHaveBeenCalled();
});

it("uses the remote even without an upstream and preserves the nothing-to-push reason", async () => {
  ahead = 0;
  await mount();
  await click("Sync");
  expect(button("Fetch").disabled).toBe(false);
  expect(button("Pull").disabled).toBe(false);
  expect(button("Push ↑0").title).toBe("Nothing to push");
});

it("keeps actions disabled while the snapshot is loading", async () => {
  mockIPC(() => new Promise(() => undefined));
  await mount();
  await click("Sync");
  for (const label of ["Fetch", "Pull", "Push ↑0"]) {
    expect(button(label).disabled).toBe(true);
    expect(button(label).title).toBe("Reading git");
  }
});

it.each([
  ["Fetch", "git_fetch", undefined],
  ["Pull", "git_pull", JSON.stringify({ status: "pulled", reason: "Updated" })],
  ["Push ↑2", "git_push", "main"],
])("closes immediately after %s and refreshes after success", async (label, command, result) => {
  await mount();
  await click("Sync");
  expect(button("Push ↑2").title).toBe("Push main to upstream");
  await click(label);
  expect(ipc).toHaveBeenCalledWith(command, expect.objectContaining({ project: "acme", scope: "project" }));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(button("Sync").disabled).toBe(true);
  expect(onMutated).not.toHaveBeenCalled();
  await act(async () => { complete(result); });
  expect(onMutated).toHaveBeenCalledTimes(1);
  expect(button("Sync").disabled).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});

it.each([
  ["Fetch", "fatal: Remote is unavailable\nDiagnostic detail"],
  ["Pull", "git merge --ff-only upstream/main failed: error: Remote is unavailable\nDiagnostic detail"],
  ["Push ↑2", new Error("git push -u upstream main failed: fatal: Remote is unavailable\nDiagnostic detail")],
])("keeps the menu closed and shows a plain first line when %s fails", async (label, error) => {
  await mount();
  await click("Sync");
  await click(label);
  expect(host.querySelector('[role="menu"]')).toBeNull();
  await act(async () => { fail(error); });
  expect(onError).toHaveBeenCalledExactlyOnceWith("Remote is unavailable");
  expect(onMutated).not.toHaveBeenCalled();
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(button("Sync").disabled).toBe(false);
});

it.each(["Merge", "Rebase"])("keeps %s available after closing a diverged pull menu", async choice => {
  await mount();
  await click("Sync");
  await click("Pull");
  await act(async () => { complete(JSON.stringify({ status: "diverged", reason: "Choose how to combine the branches" })); });
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Choose how to combine the branches");
  await click(choice);
  expect(ipc).toHaveBeenLastCalledWith("git_pull", { project: "acme", scope: "project", strategy: choice.toLowerCase() });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { complete(JSON.stringify({ status: "pulled", reason: "Updated" })); });
  expect(onMutated).toHaveBeenCalledTimes(1);
});
