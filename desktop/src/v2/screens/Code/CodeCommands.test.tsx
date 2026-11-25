// @vitest-environment happy-dom
// The Code screen registers its commands while mounted, and takes an open intent that arrives after it mounted.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { getCommands } from "../../shell/commands";
import { setOpenIntent, takeOpenIntent } from "../../shell/openIntent";
import { CodeScreen } from "./index";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const client = new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify({ tasks: [], entries: [], messages: [], peers: [] }) }));
const CHECKOUT = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, status: [], counts: [], log: [] };
const calls: string[] = [];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  mockIPC(command => {
    calls.push(command);
    if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
    if (command === "git_panel") return JSON.stringify(CHECKOUT);
    if (command === "project_changes") return "[]";
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
const find = (id: string) => getCommands().find(c => c.id === id);

describe("Code screen commands", () => {
  it("registers new terminal, search in files and fetch while mounted, and removes them on leaving", async () => {
    await mount();
    expect(["terminal.new", "search.inFiles", "git.fetch"].every(id => find(id))).toBe(true);
    act(() => root.unmount());
    expect(find("git.fetch")).toBeUndefined();
    root = createRoot(host);
  });

  it("Focus search in files shows the search view and focuses its input", async () => {
    await mount();
    await act(async () => { find("search.inFiles")?.run(); await new Promise(r => setTimeout(r, 10)); });
    expect(document.activeElement?.id).toBe("v2-text-search");
  });

  it("Fetch asks git to fetch the project", async () => {
    await mount();
    await act(async () => { find("git.fetch")?.run(); });
    await flush();
    expect(calls).toContain("git_fetch");
  });

  it("an open intent set while the screen is showing opens that file", async () => {
    await mount();
    await act(async () => { setOpenIntent("trantor", { kind: "file", path: "src/late.ts" }); });
    await flush();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("late.ts");
    expect(takeOpenIntent("trantor")).toBeUndefined();
  });
});
