// @vitest-environment happy-dom
// #14493: exercise the Workspace intent through Code with the native SSH boundary mocked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { RemoteSeatSnapshot } from "../../../features/code/remoteSeatApi";
import { HubClient } from "../../../shared/api/client";
import { setOpenIntent, takeOpenIntent } from "../../shell/openIntent";
import { SeatBar } from "../Workspace/SeatBar";
import type { SeatView } from "../Workspace/seatModel";
import type { Crew } from "../Workspace/useCrew";
import { CodeScreen } from "./index";

// SAFETY: React's test-only act flag is not part of the standard globalThis type.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const client = new HubClient("http://remote-code.test", async () => ({ status: 200, body: JSON.stringify({ peers: [], tasks: [], entries: [], messages: [] }) }));
const argsFor = (path?: string) => {
  const args = { project: "trantor", agent: "codex-8", machine: "netcup" };
  return path ? { ...args, path } : args;
};
const noAction = async () => {};
const crew: Crew = { available: [], busy: false, notice: null, start: noAction, stop: noAction, stopHelper: noAction, swap: noAction, dismiss: () => {} };
const seat: SeatView = {
  key: "codex-8:trantor", session: "codex-8:trantor", agent: "codex-8", label: "codex-8", brand: "codex", machine: "netcup",
  presence: "working", words: "working", isOrchestrator: false,
  target: { key: "codex-8:trantor", session: "codex-8:trantor", agent: "codex-8", label: "codex-8", brand: "codex", online: true, isOrchestrator: false, machine: "netcup" },
};
let snapshot: RemoteSeatSnapshot;
let commands: { command: string; args: { path?: string; machine?: string; agent?: string; scope?: string } }[];
let failure: string | null;
let ssh: string | null;
let bodyFailure: boolean;
let patchFailure: boolean;
let bodyText: string;
let truncated: boolean;
let delayedBody: Promise<string> | null;
let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { const b = button(label); expect(b).toBeDefined(); await act(async () => b?.click()); await flush(); };
const mount = async () => { await act(async () => root.render(<CodeScreen client={client} project="trantor" onNavigate={() => {}} />)); await flush(); };
const open = async () => { setOpenIntent("trantor", { kind: "source-control", seat: "codex-8", machine: "netcup" }); await mount(); };

beforeEach(() => {
  commands = []; failure = null; ssh = "netcup"; bodyFailure = false; patchFailure = false; truncated = false; delayedBody = null; bodyText = "remote unsaved contents\n";
  snapshot = {
    machine: "netcup", branch: "seat/codex-8", upstream: null, ahead: 1, behind: null, base: "abc1234",
    status: [{ path: "src/a.ts", x: " ", y: "M" }, { path: "new.txt", x: "?", y: "?" }],
    counts: [{ path: "src/a.ts", plus: 1, minus: 1 }],
    committed: [{ path: "src/a.ts", plus: 1, minus: 1 }, { path: "deleted.txt", plus: 0, minus: 1 }], log: [],
  };
  localStorage.clear(); takeOpenIntent("trantor");
  mockIPC((command, args) => {
    // SAFETY: Tauri command arguments are the named object supplied by the wrappers under test.
    const named = (args ?? {}) as { path?: string; machine?: string; agent?: string; scope?: string };
    commands.push({ command, args: named });
    if (command === "machine_ssh") return ssh;
    if (command === "remote_seat_snapshot") { if (failure) throw new Error(failure); return JSON.stringify(snapshot); }
    if (command === "remote_file_body") {
      if (bodyFailure || named.path === "deleted.txt") throw new Error("File no longer exists");
      if (delayedBody && named.path === "src/a.ts") return delayedBody;
      return JSON.stringify({ text: bodyText, bytes: bodyText.length, truncated });
    }
    if (command === "remote_file_patch") {
      if (patchFailure) throw new Error("unreachable: SSH connection closed");
      const path = named.path;
      return JSON.stringify({ patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+remote change\n`, truncated });
    }
    if (command === "git_panel") return JSON.stringify({ branch: "main", upstream: null, remote: null, ahead: 0, behind: 0, status: [], counts: [], log: [] });
    if (command === "git_stash_list") return "[]";
    if (command === "git_branch_list") return JSON.stringify({ current: "main", branches: [] });
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); takeOpenIntent("trantor"); });

describe("remote seat Code", () => {
  it("carries the Workspace remote seat through to its real changes, diff and read-only file", async () => {
    const navigate = vi.fn();
    await act(async () => root.render(<SeatBar project="trantor" seat={seat} crew={crew} card={undefined} tab="terminal" onTab={() => {}} changed={2} onNavigate={navigate} onMessage={() => {}} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open codex-8\'s worktree in Code"]')?.click());
    expect(navigate).toHaveBeenCalledWith("code");
    await mount();
    expect(host.textContent).toContain("codex-8's worktree on netcup, read only");
    expect(host.querySelector('nav[aria-label="Remote changed files"]')?.textContent).toContain("new.txt");
    expect(host.querySelector('[data-diff-scroll]')?.textContent).toContain("remote change");
    expect(commands).toContainEqual({ command: "machine_ssh", args: { machine: "netcup" } });
    expect(commands).toContainEqual({ command: "remote_seat_snapshot", args: argsFor() });
    expect(commands).toContainEqual({ command: "remote_file_patch", args: argsFor("src/a.ts") });
    await click("File");
    expect(host.querySelector('[aria-label="Remote file contents"]')?.textContent).toBe(bodyText);
    expect(commands).toContainEqual({ command: "remote_file_body", args: argsFor("src/a.ts") });
    expect(host.querySelector('[contenteditable="true"], input, textarea')).toBeNull();
    expect([...host.querySelectorAll("button")].some(b => /Save|Stage|Discard|Commit/.test(b.textContent ?? ""))).toBe(false);
    expect(commands.some(c => /^(git_|file_|seat_diff)/.test(c.command))).toBe(false);
  });

  it("keeps local seats on the existing git view", async () => {
    await act(async () => root.render(<SeatBar project="trantor" seat={{ ...seat, machine: undefined }} crew={crew} card={undefined} tab="terminal" onTab={() => {}} changed={0} onNavigate={() => {}} onMessage={() => {}} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open codex-8\'s worktree in Code"]')?.click());
    expect(takeOpenIntent("trantor")).toEqual({ kind: "source-control", seat: "codex-8", machine: undefined });
    setOpenIntent("trantor", { kind: "source-control", seat: "codex-8" });
    await mount();
    expect(host.querySelector('[data-testid="code-screen"]')).not.toBeNull();
    expect(commands.some(c => c.command === "git_panel" && c.args.agent === "codex-8")).toBe(true);
    expect(commands.some(c => c.command.startsWith("remote_"))).toBe(false);
  });

  it("shows an SSH error in place and retries with Refresh", async () => {
    failure = "unreachable: SSH connection refused";
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(failure);
    expect(host.textContent).not.toContain("No changed files");
    failure = null;
    await click("Refresh");
    expect(host.querySelector('[data-diff-scroll]')?.textContent).toContain("remote change");
  });

  it("explains missing SSH configuration without opening a local checkout", async () => {
    ssh = null; await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("No SSH target is configured for netcup");
    expect(commands.some(c => c.command === "remote_seat_snapshot" || c.command === "git_panel")).toBe(false);
  });

  it("refreshes the snapshot, body and patch, keeping a selected path that still exists", async () => {
    await open();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="new.txt"]')?.click()); await flush();
    bodyText = "fresh remote body";
    await click("Refresh"); await click("File");
    expect(host.querySelector('[aria-label="Remote file contents"]')?.textContent).toBe(bodyText);
    expect(commands.filter(c => c.command === "remote_seat_snapshot")).toHaveLength(2);
    expect(commands.filter(c => c.command === "remote_file_patch" && c.args.path === "new.txt")).toHaveLength(2);
  });

  it("shows empty snapshots honestly and drops a selection removed by refresh", async () => {
    await open(); snapshot.status = []; snapshot.committed = [];
    await click("Refresh");
    expect(host.textContent).toContain("No changed files in this remote worktree");
    expect(host.querySelector('[aria-label="Remote file viewer"]')).toBeNull();
  });

  it("keeps deleted-file diffs readable when their body is unavailable", async () => {
    await open();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="deleted.txt"]')?.click()); await flush();
    expect(host.querySelector('[data-diff-scroll]')?.textContent).toContain("remote change");
    await click("File");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("File no longer exists");
  });

  it("shows patch transport failures without hiding a readable body", async () => {
    patchFailure = true; await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("unreachable: SSH connection closed");
    await click("File");
    expect(host.querySelector('[aria-label="Remote file contents"]')?.textContent).toBe(bodyText);
  });

  it("labels truncated bodies and patches", async () => {
    truncated = true; await open();
    expect(host.textContent).toContain("This diff is too large");
    await click("File"); expect(host.textContent).toContain("This file is too large");
  });

  it("ignores a late body from the previous selection", async () => {
    let resolveBody: (body: string) => void = () => {};
    delayedBody = new Promise(resolve => { resolveBody = resolve; });
    await open();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="new.txt"]')?.click()); await flush();
    await click("File");
    await act(async () => resolveBody(JSON.stringify({ text: "stale body", bytes: 10, truncated: false }))); await flush();
    expect(host.querySelector('[aria-label="Remote file contents"]')?.textContent).toBe(bodyText);
  });

  it("honors new intents while mounted and can return to the project checkout", async () => {
    await open();
    await act(async () => setOpenIntent("trantor", { kind: "source-control", seat: "kimi-9", machine: "other-host" })); await flush();
    expect(host.textContent).toContain("kimi-9's worktree on other-host, read only");
    expect(commands.some(c => c.command === "remote_seat_snapshot" && c.args.agent === "kimi-9" && c.args.machine === "other-host")).toBe(true);
    await click("Open project checkout");
    expect(host.querySelector('[data-testid="code-screen"]')).not.toBeNull();
    expect(commands.some(c => c.command === "git_panel" && c.args.scope === "project")).toBe(true);
  });
});
