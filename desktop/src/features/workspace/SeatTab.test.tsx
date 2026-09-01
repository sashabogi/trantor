// @vitest-environment happy-dom
//
// The tab renders the CONTRACT, not a guess: the brand mark is present (aria-label carries the
// brand), the pulse class exists only while working, amber only when blocked, the blue dot is
// GONE, and the title says the state. Same harness as TerminalPane: happy-dom + createRoot + act.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SeatTab } from "./SeatTab";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SeatTab", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (props: Parameters<typeof SeatTab>[0]) =>
    act(async () => root.render(<SeatTab {...props} />));
  const tab = () => host.querySelector("button");
  const html = () => tab()?.innerHTML ?? "";

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a known agent shows its brand mark and name — no dot anywhere", async () => {
    await render({ name: "codex", brandName: "codex", status: "idle", active: false, onClick: () => {} });
    expect(tab()?.getAttribute("aria-label") ?? host.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Codex");
    expect(host.querySelector(".tr-dot")).toBeNull();
    expect(html()).toContain("codex");
  });

  it("working: the mark pulses and the title says working", async () => {
    await render({ name: "codex", brandName: "codex", status: "working", active: true, onClick: () => {} });
    expect(tab()?.title).toBe("codex — working");
    expect(html()).toContain("animate-pulse");
    expect(html()).not.toContain("ring-tr-warn");
  });

  it("blocked: amber ring + amber name, no pulse", async () => {
    await render({ name: "kimi", brandName: "kimi", status: "blocked", active: false, onClick: () => {} });
    expect(tab()?.title).toBe("kimi — blocked, waiting on you");
    expect(html()).toContain("ring-tr-warn");
    expect(html()).toContain("text-tr-warn");
    expect(html()).not.toContain("animate-pulse");
  });

  it("idle: still — no pulse, no amber", async () => {
    await render({ name: "glm", brandName: "glm", status: "idle", active: false, onClick: () => {} });
    expect(tab()?.title).toBe("glm — idle");
    expect(html()).not.toContain("animate-pulse");
    expect(html()).not.toContain("ring-tr-warn");
  });

  it("the orchestrator keeps its you chip", async () => {
    await render({ name: "orchestrator", brandName: "claude", status: "idle", active: true, onClick: () => {}, you: true });
    expect(host.textContent).toContain("you");
    expect(host.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Claude");
  });

  it("an unknown agent falls back to a monogram, not a gap", async () => {
    await render({ name: "newbot", brandName: "newbot", status: "idle", active: false, onClick: () => {} });
    expect(host.textContent).toContain("ne");
    expect(host.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("newbot");
  });
});
