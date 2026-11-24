// @vitest-environment happy-dom
// #14030: Settings > About carries the quiet Agent CLIs list; a below-minimum row carries the
// same Update button, and the sessions still on the old binary are listed here too. IPC fakes only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AgentCliCompatibility, AgentCliStaleSessions, AgentCliUpdate } from "../../../shared/api/client";
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
let invokes: Array<{ cmd: string; args?: InvokeArgs }>;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); invokes = []; });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });

/** What one mount fakes: the updater's answer and the stale-session report. */
type MountDeps = { update?: AgentCliUpdate; sessions?: AgentCliStaleSessions };

const mount = async (reports: AgentCliCompatibility[], deps: MountDeps = {}) => {
  mockIPC((cmd: string, args?: InvokeArgs) => {
    invokes.push({ cmd, args });
    if (cmd === "agent_cli_compatibility") return reports;
    if (cmd === "agent_cli_update") return deps.update ?? null;
    if (cmd === "agent_cli_stale_sessions") return deps.sessions ?? null;
    return null;
  });
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

  it("a below-minimum row carries the same Update button, which runs the CLI's own updater", async () => {
    await mount([row({ installed: "2.1.100", state: "below_minimum", reason: "the Mode menu needs 2.1.326" })],
      { update: { ok: true, before: "2.1.100", after: "2.1.326", output: "updated" } });
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Update Claude Code");
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); });
    expect(invokes.filter(i => i.cmd === "agent_cli_update")).toEqual([{ cmd: "agent_cli_update", args: { cli: "claude" } }]);
    expect(host.querySelector('[data-agent-cli="claude"]')?.textContent).toContain("updated 2.1.100 to 2.1.326");
  });

  it("lists the sessions still on the old binary, with the machine-local footer", async () => {
    await mount([row({})], {
      sessions: {
        rows: [
          { project: "trantor", seat: "orchestrator", restart: "handoff", stale: "before_update" },
          { project: "crebral", seat: "codex", restart: "agents", stale: "may_be_old" },
        ],
        machinesNotChecked: ["netcup"],
      },
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const list = host.querySelector('[data-agent-cli-sessions="claude"]');
    expect(list?.textContent).toContain("trantor");
    expect(list?.textContent).toContain("started before the update");
    expect(list?.textContent).toContain("restart it from Agents");
    expect(list?.textContent).toContain("not checked on netcup");
    expect(invokes.filter(i => i.cmd === "agent_cli_stale_sessions")).toEqual([{ cmd: "agent_cli_stale_sessions", args: { cli: "claude" } }]);
  });

  it("an ok row offers no Update button", async () => {
    await mount([row({})]);
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Update Claude Code")).toBeUndefined();
  });
});
