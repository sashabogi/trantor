// @vitest-environment happy-dom
// #14030: Settings > About carries the quiet Agent CLIs list — name, installed, state in words —
// for every state; the banner stays the only loud surface.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { AgentCliCompatibility } from "../../../shared/api/client";
import { AgentClisCard } from "./SystemPages";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<AgentCliCompatibility>): AgentCliCompatibility => ({
  cli: "claude",
  label: "Claude Code",
  installed: "2.1.326",
  state: "ok",
  minimum: "2.1.215",
  verifiedUpTo: "2.1.326",
  reason: null,
  updateCommand: "claude update",
  features: [],
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });

const mount = async (reports: AgentCliCompatibility[]) => {
  mockIPC(cmd => (cmd === "agent_cli_compatibility" ? reports : null));
  await act(async () => { root.render(<AgentClisCard key={reports.map(r => r.state).join(",")} />); });
};

describe("AgentClisCard", () => {
  it("lists each CLI's name, version and state in words", async () => {
    await mount([
      row({}),
      row({ cli: "codex", label: "Codex CLI", installed: "2.1.100", state: "below_minimum", reason: "the Mode menu needs 2.1.326 (reads the mode line Claude Code prints under its input box)" }),
    ]);
    const claudeRow = host.querySelector('[data-agent-cli="claude"]');
    expect(claudeRow?.textContent).toContain("Claude Code");
    expect(claudeRow?.textContent).toContain("2.1.326");
    expect(claudeRow?.textContent).toContain("within the verified range (2.1.215–2.1.326)");
    expect(host.querySelector('[data-agent-cli="codex"]')?.textContent).toContain("older than Trantor needs (2.1.215)");
  });

  it("says not installed plainly when the CLI is absent", async () => {
    await mount([row({ installed: null, state: "not_installed" })]);
    expect(host.querySelector('[data-agent-cli="claude"]')?.textContent).toContain("not installed");
  });

  it("keeps newer-than-verified a quiet line, never an alert", async () => {
    await mount([row({ installed: "2.1.400", state: "newer_than_verified", reason: "newer than the newest release Trantor has verified (2.1.326)" })]);
    expect(host.querySelector('[data-agent-cli="claude"]')?.textContent).toContain("newer than the verified range (up to 2.1.326)");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("says it is still reading while the rows load", async () => {
    mockIPC(() => new Promise(() => {}));
    await act(async () => { root.render(<AgentClisCard />); });
    expect(host.textContent).toContain("Reading installed agent CLIs…");
  });
});
