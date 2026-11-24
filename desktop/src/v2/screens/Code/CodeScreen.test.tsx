// @vitest-environment happy-dom
// #13988: the screen folds its sidebar while Source control is open, groups seats in the branch
// picker, and reads history and changes from the classic git commands.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { CodeScreen } from "./index";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PEERS = { peers: [{ session: "codex-8:trantor", project: "trantor", lastSeen: Date.now(), machine: "netcup" }] };
const PANEL = {
  branch: "seat/codex-8", upstream: null, ahead: 3, behind: null, status: [], counts: [],
  log: [{ sha: "abc1234", author: "sashabogi", when: "2 hours ago", subject: "#13970 Restore opted-in projects" }],
};

const client = new HubClient("http://hub.test", async ({ path }) => {
  if (path.startsWith("/peers")) return { status: 200, body: JSON.stringify(PEERS) };
  return { status: 200, body: JSON.stringify({ tasks: [], entries: [], messages: [] }) };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; the git commands are invoked with an object carrying agent.
    const agent = (args as { agent?: string } | undefined)?.agent;
    if (command === "project_changes") return JSON.stringify([{ seat: null, path: "bin/a.mjs", status: "M", plus: 4, minus: 1 }]);
    if (command === "git_panel") return JSON.stringify(agent === "codex-8" ? PANEL : null);
    if (command === "file_diff") return "diff --git a/bin/a.mjs b/bin/a.mjs\n--- a/bin/a.mjs\n+++ b/bin/a.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    if (command === "seat_diff") return JSON.stringify({ branch: "seat/codex-8", base: "deadbee", files: [], patch: "", truncated: false });
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async () => { await act(async () => { root.render(<CodeScreen client={client} project="trantor" onNavigate={() => undefined} />); }); await flush(); await flush(); };
const click = async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)?.click(); }); await flush(); };

describe("CodeScreen", () => {
  it("folds the source control sidebar into the icon bar while the Source control tab is open", async () => {
    await mount();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Source control");
    expect(host.querySelector('aside[aria-label="Source control"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Show the source control sidebar"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Source control, 1 change"]')).not.toBeNull();
    await click('button[aria-label="Explorer"]');
    expect(host.querySelector('aside[aria-label="Explorer"]')).not.toBeNull();
  });

  it("lists the changed file as a chip above the diff and never wraps code", async () => {
    await mount();
    const chip = host.querySelector('[aria-label="Changed files"] button');
    expect(chip?.textContent).toContain("bin/a.mjs");
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("new");
    expect(host.querySelector('[data-kind="add"]')?.className).toContain("whitespace-pre");
  });

  it("groups seats in the branch picker and reads history from the seat's panel", async () => {
    await mount();
    await click('button[title="Switch branch"]');
    const picker = host.querySelector('[role="dialog"][aria-label="Switch branch"]');
    expect(picker?.textContent).toContain("This checkout");
    expect(picker?.textContent).toContain("Seats · each in its own worktree");
    expect(picker?.textContent).toContain("seat/codex-8");
    const row = [...(picker?.querySelectorAll("button") ?? [])].find(b => b.textContent?.includes("seat/codex-8"));
    await act(async () => { row?.click(); });
    await flush();
    await flush();
    const commit = host.querySelector('[data-sha="abc1234"]');
    expect(commit?.textContent).toContain("Restore opted-in projects");
    expect(commit?.textContent).toContain("#13970");
    expect(commit?.textContent).toContain("codex-8");
    expect(host.querySelector('[data-sha="unlanded"]')?.textContent).toContain("3 commits not on main yet");
  });
});
