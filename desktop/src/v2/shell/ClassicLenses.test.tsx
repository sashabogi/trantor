// @vitest-environment happy-dom
// #13984 drill: an embedded classic lens must not draw a second title and lens row under the 2.0 tabs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "../../shared/api/client";
import { ClassicLens } from "./ClassicLenses";
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
afterEach(() => { act(() => root.unmount()); host.remove(); style.remove(); vi.restoreAllMocks(); });

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
});
