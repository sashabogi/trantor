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
  scope: null, branch: "main", upstream: "origin/main", remote: "origin", ahead: 1, behind: 0,
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
const menuItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === text);
const openMenu = () => click(host.querySelector<HTMLElement>('button[aria-label="More commit actions"]'));
const field = (id: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(id);
const mount = async (snapshot: ScopeSnapshot = snap, staged = 1) => {
  await act(async () => { root.render(<CommitBox project="trantor" snap={snapshot} staged={staged} onDone={done} onError={errors} />); });
  await flush();
};
const typeInto = async (target: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, value);
    target?.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
    await openMenu();
    await click(menuItem("Amend last commit"));
    expect(host.querySelector<HTMLInputElement>("#v2-commit-msg")?.value).toBe("previous subject");
    expect(host.textContent).toContain("Amending the last commit");
    await click(button("Amend commit"));
    expect(calls.find(call => call.command === "git_commit_amend")?.args).toEqual({ project: "trantor", scope: "project", message: "previous subject" });
    expect(done).toHaveBeenCalled();
  });

  it("undoes an unpushed commit and restores its message", async () => {
    await mount();
    await openMenu();
    await click(menuItem("Undo last commit"));
    expect(calls.find(call => call.command === "git_commit_undo")?.args).toEqual({ project: "trantor", scope: "project" });
    expect(host.querySelector<HTMLInputElement>("#v2-commit-msg")?.value).toBe("previous message");
    expect(done).toHaveBeenCalled();
  });

  it("refuses amend and undo in the menu when HEAD is already pushed", async () => {
    await mount({ ...snap, ahead: 0 });
    await openMenu();
    expect(menuItem("Amend last commit")?.disabled).toBe(true);
    expect(menuItem("Undo last commit")?.disabled).toBe(true);
    expect(menuItem("Undo last commit")?.title).toContain("already pushed");
    expect(calls).toEqual([]);
  });

  it("commits first and then pushes as the second commit action", async () => {
    await mount();
    await message("ship G3");
    await openMenu();
    await click(menuItem("Commit and push"));
    expect(calls.map(call => call.command)).toEqual(["git_commit", "git_push"]);
    expect(calls[0].args).toEqual({ project: "trantor", scope: "project", message: "ship G3" });
    expect(done).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not commit on the main checkout when Orchestrator mode refuses the push", async () => {
    localStorage.setItem(MODE_KEY, "orchestrator");
    await mount();
    await message("must not commit");
    await openMenu();
    expect(menuItem("Commit and push")?.disabled).toBe(true);
    await click(menuItem("Commit and push"));
    expect(calls).toEqual([]);
  });
});

describe("CommitBox, the calm commit area (#14344)", () => {
  it("shows only the message field and the quiet last commit while nothing is staged", async () => {
    await mount(snap, 0);
    expect(field("#v2-commit-msg")?.placeholder).toBe("Message for your commit");
    expect(field("#v2-commit-desc")).toBeNull();
    expect(button("Commit ")).toBeUndefined();
    expect(host.textContent).toContain("Nothing to commit");
    expect(host.textContent).toContain("previous subject");
    expect(host.querySelector("[data-char-count]")).toBeNull();
  });

  it("with files staged it grows a description, a character count and one Commit N files button", async () => {
    await mount(snap, 3);
    expect(field("#v2-commit-desc")).not.toBeNull();
    const primary = button("Commit 3 files");
    expect(primary).toBeDefined();
    expect(primary?.textContent).not.toContain("main");
    expect(primary?.textContent).toContain("⌘↵");
    await message("twelve chars");
    expect(host.querySelector("[data-char-count]")?.textContent).toBe("12");
  });

  it("turns the count warn past 72 characters", async () => {
    await mount(snap, 1);
    await message("x".repeat(72));
    expect(host.querySelector("[data-char-count]")?.className).not.toContain("--v2-warn");
    await message("x".repeat(73));
    expect(host.querySelector("[data-char-count]")?.className).toContain("--v2-warn");
  });

  it("sends the description after a blank line, and Cmd+Enter commits from the field", async () => {
    await mount(snap, 2);
    await message("the summary");
    await typeInto(field("#v2-commit-desc"), "why it changed");
    await act(async () => { field("#v2-commit-msg")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    await flush();
    expect(calls.find(call => call.command === "git_commit")?.args).toEqual({ project: "trantor", scope: "project", message: "the summary\n\nwhy it changed" });
  });

  it("the split chevron lists the three rare actions and the button never repeats the branch", async () => {
    await mount();
    await openMenu();
    expect([...host.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Commit and push", "Amend last commit", "Undo last commit"]);
    expect(host.textContent).not.toContain("to main");
  });
});
