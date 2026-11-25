// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { CommitBox } from "./ChangesList";
import { MODE_KEY } from "../../shell/shellMode";
import type { ScopeSnapshot } from "./useScopeGit";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = { project?: string; scope?: string; message?: string };
type Call = { command: string; args: Args };
let calls: Call[];
let host: HTMLDivElement;
let root: Root;
let done: ReturnType<typeof vi.fn>;
let errors: ReturnType<typeof vi.fn>;

const snap: ScopeSnapshot = {
  scope: null, branch: "main", upstream: "origin/main", ahead: 1, behind: 0,
  status: [], counts: [], log: [{ sha: "abc1234", author: "Tess", when: "now", subject: "previous subject" }], seatBacked: false, readAt: 1,
};

beforeEach(() => {
  calls = [];
  done = vi.fn(); errors = vi.fn();
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  localStorage.setItem(MODE_KEY, "developer");
  mockIPC((command, raw) => {
    // SAFETY: every mocked invoke uses this command's named argument object.
    calls.push({ command, args: (raw ?? {}) as Args });
    if (command === "git_commit_undo") return "previous message";
    if (command === "git_push") return "main";
    return "abc1234";
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const click = async (target: HTMLElement | null | undefined) => { await act(async () => { target?.click(); }); await flush(); };
const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent?.includes(text));
const mount = async (snapshot: ScopeSnapshot = snap, staged = 1) => {
  await act(async () => { root.render(<CommitBox project="trantor" snap={snapshot} staged={staged} onDone={done} onError={errors} />); });
  await flush();
};
const message = async (value: string) => {
  const field = host.querySelector<HTMLInputElement>("#v2-commit-msg");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("CommitBox G3", () => {
  it("loads the last subject and amends even when nothing new is staged", async () => {
    await mount(snap, 0);
    await click(host.querySelector<HTMLElement>('input[type="checkbox"]'));
    expect(host.querySelector<HTMLInputElement>("#v2-commit-msg")?.value).toBe("previous subject");
    await click(button("Amend commit"));
    expect(calls.find(call => call.command === "git_commit_amend")?.args).toEqual({ project: "trantor", scope: "project", message: "previous subject" });
    expect(done).toHaveBeenCalled();
  });

  it("undoes an unpushed commit and restores its message", async () => {
    await mount();
    await click(button("Undo last commit"));
    expect(calls.find(call => call.command === "git_commit_undo")?.args).toEqual({ project: "trantor", scope: "project" });
    expect(host.querySelector<HTMLInputElement>("#v2-commit-msg")?.value).toBe("previous message");
    expect(done).toHaveBeenCalled();
  });

  it("refuses amend and undo in the controls when HEAD is already pushed", async () => {
    await mount({ ...snap, ahead: 0 });
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(button("Undo last commit")?.disabled).toBe(true);
    expect(button("Undo last commit")?.title).toContain("already pushed");
    expect(calls).toEqual([]);
  });

  it("commits first and then pushes as the second commit action", async () => {
    await mount();
    await message("ship G3");
    await click(button("Commit and push"));
    expect(calls.map(call => call.command)).toEqual(["git_commit", "git_push"]);
    expect(calls[0].args).toEqual({ project: "trantor", scope: "project", message: "ship G3" });
    expect(done).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not commit on the main checkout when Orchestrator mode refuses the push", async () => {
    localStorage.setItem(MODE_KEY, "orchestrator");
    await mount();
    await message("must not commit");
    expect(button("Commit and push")?.disabled).toBe(true);
    await click(button("Commit and push"));
    expect(calls).toEqual([]);
  });

  it("wraps the commit buttons instead of clipping them, each filling its own line", async () => {
    await mount();
    const commit = button("Commit 1 file to main");
    const push = button("Commit and push");
    expect(commit).toBeTruthy();
    expect(push).toBeTruthy();
    expect(commit?.parentElement?.className).toContain("flex-wrap");
    for (const target of [commit, push]) {
      expect(target?.className).toContain("grow");
      expect(target?.className).toContain("shrink-0");
      expect(target?.className).toContain("basis-auto");
    }
  });
});
