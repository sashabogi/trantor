// @vitest-environment happy-dom
// #13984 drill: an embedded classic lens must not draw a second title and lens row under the 2.0 tabs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient, type HubEvent } from "../../shared/api/client";
import { ClassicLens, MessagesLens } from "./ClassicLenses";
import { clearGraphBack, currentGraphBack } from "./graphBack";
import { takeOpenIntent } from "./openIntent";
import { openMessagesWith, takeMessagesFocus } from "./messagesFocus";
import { SIX_NODE_GRAPH } from "../../features/code/graph/fixture";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Screen } from "../routes";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  style = document.createElement("style");
  style.textContent = readFileSync("src/v2/theme.css", "utf8");
  document.head.append(style);
});
afterEach(() => { act(() => root.unmount()); host.remove(); style.remove(); clearMocks(); clearGraphBack(); takeMessagesFocus(); vi.restoreAllMocks(); });

describe("embedded classic lenses", () => {
  it("hides the classic header (title + lens row) but keeps the Feed's own filters", async () => {
    const client = new HubClient("http://127.0.0.1:1");
    vi.spyOn(client, "events").mockResolvedValue({ events: [] });
    vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
    act(() => root.render(<ClassicLens client={client} project="trantor" me="sasha" lens="feed" onNavigate={() => {}} />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const header = host.querySelector("[data-v2-embed] header");
    if (!header) throw new Error("the classic lens drew no header at all");
    expect(getComputedStyle(header).display).toBe("none");
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "all")).toBe(true);
  });

  // #14495: the file the graph opens must land in Code with the intent and the way back recorded.
  it("a file clicked on the graph sets Code's file intent, the graph origin, and navigates to Code", async () => {
    mockIPC(command => {
      if (command === "code_graph") return JSON.stringify(SIX_NODE_GRAPH);
      if (command === "code_attribution") return JSON.stringify({ head: "abc", files: [], agents: [], coverage: { total: 0, rules: [] } });
      if (command === "project_changes") return "[]";
      if (command === "plugin:event|listen") return 1;
      return null;
    });
    const client = new HubClient("http://127.0.0.1:1");
    vi.spyOn(client, "peers").mockResolvedValue([]);
    vi.spyOn(client, "events").mockResolvedValue({ events: [] });
    vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
    const gone: [Screen, string | undefined][] = [];
    act(() => root.render(<ClassicLens client={client} project="trantor" me="sasha" lens="graph" onNavigate={(s, p) => gone.push([s, p])} />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // The districts view starts collapsed: open a cluster to surface its file nodes.
    act(() => { host.querySelector('[data-graph-kind="cluster"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const file = host.querySelector('[data-graph-kind="file"]');
    const path = file?.getAttribute("data-graph-node") ?? "";
    expect(path).not.toBe("");
    act(() => { file?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(takeOpenIntent("trantor")).toEqual({ kind: "file", path, fromGraph: true });
    expect(currentGraphBack()).toEqual({ project: "trantor", path });
    expect(gone).toEqual([["code", undefined]]);
  });
});

describe("MessagesLens focus (#14495)", () => {
  const ev = (by: string, text: string, id: number): HubEvent => ({ id, ts: id * 1000, type: "message", by, toSession: "sasha", text, project: "trantor", msgId: id });

  it("an Inbox jump opens the sender's thread, and a later jump switches threads", async () => {
    const client = new HubClient("http://127.0.0.1:1");
    vi.spyOn(client, "events").mockResolvedValue({
      events: [ev("glm-5:trantor", "the glm thread", 1), ev("codex-8:trantor", "ship the ring", 2)],
    });
    vi.spyOn(client, "peers").mockResolvedValue([]);
    vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
    openMessagesWith("codex-8:trantor");
    act(() => root.render(<MessagesLens client={client} me="sasha" />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const thread = host.querySelector("section");
    expect(thread?.textContent).toContain("codex-8:trantor");
    expect(thread?.textContent).toContain("ship the ring");
    expect(thread?.textContent).not.toContain("the glm thread");
    expect(takeMessagesFocus()).toBeNull();
    // A second jump while Messages is already on screen retargets the open thread.
    await act(async () => { openMessagesWith("glm-5:trantor"); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector("section")?.textContent).toContain("the glm thread");
  });
});
