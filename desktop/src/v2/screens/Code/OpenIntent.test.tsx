// @vitest-environment happy-dom
// #13987 drill: the Code screen takes the note Workspace left (a file, or source control) instead of dropping it.
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC(command => {
    if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
    if (command === "project_changes") return "[]";
    if (command === "git_panel") return JSON.stringify(null);
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

  it("without an intent the screen opens on Source control as before", async () => {
    await mount();
    expect(activeTab()).toContain("Source control");
  });
});
