// @vitest-environment happy-dom
// #13987/#14044 drill: the Code screen takes the note Workspace left — a file, source control, a
// changed file's diff, or a commit in History — instead of dropping it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { setOpenIntent, takeOpenIntent } from "../../shell/openIntent";
import { CodeScreen } from "./index";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PEERS = { peers: [{ session: "codex-8:trantor", project: "trantor", lastSeen: Date.now() }] };
const client = new HubClient("http://hub.test", async ({ path }) => {
  if (path.startsWith("/peers")) return { status: 200, body: JSON.stringify(PEERS) };
  return { status: 200, body: JSON.stringify({ tasks: [], entries: [], messages: [] }) };
});
const PANEL = {
  branch: "seat/codex-8", upstream: null, ahead: 3, behind: null,
  status: [{ path: "src/a.ts", x: " ", y: "M" }], counts: [{ path: "src/a.ts", plus: 6, minus: 2 }],
  log: [{ sha: "abc1234", author: "sashabogi", when: "2 hours ago", subject: "#13970 Restore opted-in projects" }],
};
const CHECKOUT = {
  branch: "main", upstream: "origin/main", ahead: 0, behind: 0,
  status: [{ path: "bin/a.mjs", x: " ", y: "M" }], counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }],
  log: [{ sha: "fedcba9", author: "orchestrator", when: "5 minutes ago", subject: "#13988 Land the checkout panel" }],
};
const SHOW = {
  sha: "fedcba9000000000000000000000000000000000", truncated: false,
  files: [{ path: "src/landed.ts", status: "M", plus: 1, minus: 1 }],
  patch: "diff --git a/src/landed.ts b/src/landed.ts\n--- a/src/landed.ts\n+++ b/src/landed.ts\n@@ -1,1 +1,1 @@\n-before\n+after landing\n",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; the git commands are invoked with an object of named args.
    const named = (args ?? {}) as { agent?: string; scope?: string; sha?: string; path?: string };
    if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
    if (command === "project_changes") return "[]";
    if (command === "git_panel") return JSON.stringify(named.agent === "codex-8" ? PANEL : CHECKOUT);
    if (command === "git_show") return JSON.stringify(SHOW);
    if (command === "file_diff") return `diff --git a/${named.path} b/${named.path}\n--- a/${named.path}\n+++ b/${named.path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
    if (command === "seat_diff") return JSON.stringify({ branch: "seat/codex-8", base: "deadbee", files: [], patch: "", truncated: false });
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); takeOpenIntent("trantor"); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const mount = async () => { await act(async () => { root.render(<CodeScreen client={client} project="trantor" onNavigate={() => undefined} />); }); await flush(); await flush(); };
const activeTab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";

describe("open intent", () => {
  it("a file intent opens that file in a file tab, in the seat's scope, and is consumed", async () => {
    setOpenIntent("trantor", { kind: "file", path: "src/a.ts", seat: "codex-8" });
    await mount();
    expect(activeTab()).toContain("a.ts");
    // The Monaco editor is lazy; its fallback proves the file tab, not Source control, is the main view.
    expect(host.textContent).toContain("Opening the editor");
    expect(host.textContent).toContain("codex-8");
    expect(takeOpenIntent("trantor")).toBeUndefined();
  });

  it("a source-control intent lands on the Source control tab in the seat's scope", async () => {
    setOpenIntent("trantor", { kind: "source-control", seat: "codex-8" });
    await mount();
    expect(activeTab()).toContain("Source control");
    expect(host.textContent).toContain("codex-8");
    expect(takeOpenIntent("trantor")).toBeUndefined();
  });

  it("a change intent opens the changes view on that file's diff, even on a seat scope", async () => {
    setOpenIntent("trantor", { kind: "change", path: "src/a.ts", seat: "codex-8" });
    await mount();
    expect(activeTab()).toContain("Source control");
    expect(host.querySelector('button[title="src/a.ts"][aria-pressed="true"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Changed files"]')?.textContent).toContain("src/a.ts");
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("new");
    expect(takeOpenIntent("trantor")).toBeUndefined();
  });

  // #14084 drill: the timeline named a file committed long ago, and the click landed on an unrelated change.
  it("a change intent for a file with no uncommitted change opens the file itself", async () => {
    setOpenIntent("trantor", { kind: "change", path: "src/committed.ts" });
    await mount();
    const active = host.querySelector('[role="tab"][aria-selected="true"]');
    expect(active?.textContent).toContain("committed.ts");
  });

  it("a commit intent switches to History with that commit selected", async () => {
    setOpenIntent("trantor", { kind: "commit", sha: "fedcba9" });
    await mount();
    expect(activeTab()).toContain("Source control");
    expect(host.querySelector('[data-sha="fedcba9"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("after landing");
    expect(takeOpenIntent("trantor")).toBeUndefined();
  });

  it("without an intent the screen opens on Source control as before", async () => {
    await mount();
    expect(activeTab()).toContain("Source control");
  });
});
