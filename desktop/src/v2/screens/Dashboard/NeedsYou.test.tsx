// @vitest-environment happy-dom
// #13984 drill: the queue shows 12 rows then asks; the over-a-week testing cards are one closing row.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsYou } from "./NeedsYou";
import type { QueueItem } from "./model";
import type { Decisions } from "./useDecisions";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => Promise.resolve();
const d: Decisions = { decided: new Set<string>(), busy: "", error: "", decideProposal: noop, decideHold: noop };
const items = (n: number): QueueItem[] =>
  Array.from({ length: n }, (_, i) => ({ key: `testing:${i}`, kind: "testing", project: "p", seat: "s", title: `row ${i}`, ts: i }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const btn = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text));

describe("NeedsYou", () => {
  it("caps at 12 rows and expands on Show N more", () => {
    act(() => root.render(<NeedsYou items={items(20)} backlog={{ count: 0, project: "" }} d={d} onNavigate={() => {}} />));
    expect(host.querySelectorAll("[data-kind='testing']").length).toBe(12);
    act(() => btn("Show 8 more")?.click());
    expect(host.querySelectorAll("[data-kind='testing']").length).toBe(20);
    expect(btn("Show")).toBeUndefined();
  });

  it("ends with one backlog row that opens the Board on the busiest project", () => {
    const onNavigate = vi.fn();
    act(() => root.render(<NeedsYou items={items(2)} backlog={{ count: 100, project: "trantor" }} d={d} onNavigate={onNavigate} />));
    const rows = [...host.querySelectorAll("[data-kind]")];
    const last = rows[rows.length - 1];
    expect(last?.getAttribute("data-kind")).toBe("backlog");
    expect(last?.textContent).toContain("100 cards have sat in testing over a week");
    expect(host.querySelector("h2")?.textContent).toContain("2");
    act(() => btn("Open the Board")?.click());
    expect(onNavigate).toHaveBeenCalledWith("board", "trantor");
  });
});
