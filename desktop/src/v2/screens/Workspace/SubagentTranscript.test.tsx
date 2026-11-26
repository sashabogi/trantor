// @vitest-environment happy-dom
// #14327: a sub-agent's tab draws the same 2.0 transcript the chat does, read-only: no composer, no classic turn loop.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SubagentPane } from "./SubagentPane";
import type { SeatView } from "./seatModel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const META = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC(command => {
    if (command !== "subagent_tail") return null;
    const turns = [
      { role: "user", blocks: [{ kind: "text", text: "survey the hub tests" }], ts: 1000 },
      { role: "assistant", blocks: [
        { kind: "tool", tool: "Read", text: "hub/a.mjs", tool_id: "t1", tool_kind: "explore", paths: ["/r/hub/a.mjs"] },
        { kind: "tool", tool: "Read", text: "hub/b.mjs", tool_id: "t2", tool_kind: "explore", paths: ["/r/hub/b.mjs"] },
        { kind: "text", text: "Two files, both fine." },
      ], ts: 30_000 },
    ];
    const results = [{ tool_id: "t1", ok: true, preview: "" }, { tool_id: "t2", ok: true, preview: "" }];
    return JSON.stringify([turns, results, 2, META, []]);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); });

// SAFETY: SubagentPane reads only label and agentInfo from the seat.
const seat = {
  label: "explorer",
  agentInfo: { id: "a1", description: "survey", subagentType: "Explore", startedMs: 0, lastActivityMs: 0, rows: 2, state: "done" },
} as SeatView;

describe("SubagentPane", () => {
  it("draws the shared transcript: the prompt as a bubble, the work folded, the reply as plain text", async () => {
    await act(async () => { root.render(<SubagentPane project="p" seat={seat} />); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(host.querySelector('[data-testid="transcript"]')).not.toBeNull();
    expect(host.querySelector('[role="log"] [data-testid="transcript"]')).not.toBeNull();
    expect(host.querySelector("[data-prompt-id]")?.textContent).toBe("survey the hub tests");
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "Explored 2 files")).toBe(true);
    expect(host.textContent).toContain("Two files, both fine.");
    expect(host.querySelector("textarea, input")).toBeNull();
    expect(host.textContent).not.toMatch(/\bprompt\b.*\bagent\b/);
  });
});
