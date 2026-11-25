// @vitest-environment happy-dom
// #13984 drill: the queue shows 12 rows then asks; old testing projects are rolled-up rows.
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
    act(() => root.render(<NeedsYou items={items(20)} d={d} onNavigate={() => {}} />));
    expect(host.querySelectorAll("[data-kind='testing']").length).toBe(12);
    expect(host.querySelector("h2")?.textContent).toBe("Needs you 0");
    expect(host.querySelector("h3")?.textContent).toBe("Waiting for a drill 20");
    act(() => btn("Show 8 more")?.click());
    expect(host.querySelectorAll("[data-kind='testing']").length).toBe(20);
    expect(btn("Show")).toBeUndefined();
  });

  it("renders a project testing rollup with its oldest age and opens that Board", () => {
    const onNavigate = vi.fn();
    const rollup: QueueItem = { key: "testing:old:trantor", kind: "testing", project: "trantor", seat: "", title: "trantor: 41 cards in testing over a week", ts: Date.now() - 20 * 864e5, testingCount: 41 };
    act(() => root.render(<NeedsYou items={[rollup]} d={d} onNavigate={onNavigate} />));
    expect(host.querySelectorAll("[data-kind='testing']")).toHaveLength(1);
    expect(host.textContent).toContain("trantor: 41 cards in testing over a week");
    expect(host.textContent).toContain("20d");
    expect(host.querySelector("h2")?.textContent).toBe("Needs you 0");
    expect(host.querySelector("h3")?.textContent).toBe("Waiting for a drill 41");
    act(() => btn("Review")?.click());
    expect(onNavigate).toHaveBeenCalledWith("board", "trantor");
  });

  it("matches the actionable headline and counts drills separately", () => {
    const questions: QueueItem[] = [
      { key: "message:1", kind: "message", project: "p", seat: "kimi-9:p", title: "Question", ts: 1 },
      { key: "message:2", kind: "message", project: "p", seat: "glm-5:p", title: "Another question", ts: 2 },
    ];
    act(() => root.render(<NeedsYou items={[...questions, ...items(2)]} d={d} onNavigate={() => {}} />));
    expect(host.querySelector("h2")?.textContent).toBe("Needs you 2");
    expect(host.querySelector("h3")?.textContent).toBe("Waiting for a drill 2");
    expect(host.querySelectorAll("[data-kind='message']")).toHaveLength(2);
    expect(host.querySelectorAll("[data-kind='testing']")).toHaveLength(2);
  });
});
