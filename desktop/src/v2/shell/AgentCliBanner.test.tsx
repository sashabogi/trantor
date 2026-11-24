// @vitest-environment happy-dom
// #14030: the banner updates on a click, stays quiet otherwise, and after a successful update
// lists the sessions still on the old binary with ONE confirmed handoff each. IPC fakes only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AgentCliCompatibility, AgentCliStaleSessions, AgentCliUpdate } from "../../shared/api/client";
import { AgentCliBanner } from "./AgentCliBanner";
import { featureInRange } from "./agentCli";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claude = (over: Partial<AgentCliCompatibility>): AgentCliCompatibility => ({
  cli: "claude",
  label: "Claude Code",
  installed: "2.1.100",
  state: "below_minimum",
  minimum: "2.1.215",
  verifiedUpTo: "2.1.326",
  reason: "the Mode menu needs 2.1.326 (reads the mode line Claude Code prints under its input box)",
  updateCommand: "claude update",
  features: [{ name: "Mode menu", verifiedFrom: "2.1.326", verifiedTo: "2.1.326", why: "reads the mode line Claude Code prints under its input box", inRange: false }],
  ...over,
});

const stale: AgentCliStaleSessions = {
  rows: [
    { project: "trantor", seat: "orchestrator", restart: "handoff", stale: "before_update" },
    { project: "crebral", seat: "codex", restart: "agents", stale: "may_be_old" },
  ],
  machinesNotChecked: ["netcup"],
};

const updateOk: AgentCliUpdate = { ok: true, before: "2.1.100", after: "2.1.326", output: "updated" };

let host: HTMLDivElement;
let root: Root;
let invokes: Array<{ cmd: string; args?: InvokeArgs }>;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); invokes = []; });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

/** What one mount fakes: the updater's answer, the stale-session report, the handoff recorder. */
type MountDeps = {
  update?: () => AgentCliUpdate | Promise<AgentCliUpdate>;
  sessions?: () => AgentCliStaleSessions;
  handoffNow?: (call: { project: string; reason: string }) => string;
};

const mount = async (reports: AgentCliCompatibility[], deps: MountDeps = {}) => {
  mockIPC((cmd: string, args?: InvokeArgs) => {
    invokes.push({ cmd, args });
    if (cmd === "agent_cli_compatibility") return reports;
    if (cmd === "agent_cli_update" && deps.update) return deps.update();
    if (cmd === "agent_cli_stale_sessions" && deps.sessions) return deps.sessions();
    if (cmd === "handoff_now" && deps.handoffNow) {
      // SAFETY: the banner invokes handoff_now with exactly { project, reason } (RestartWithHandoffButton).
      const call = args as { project: string; reason: string };
      return deps.handoffNow(call);
    }
    return null;
  });
  await act(async () => { root.render(<AgentCliBanner key={reports.map(r => `${r.cli}:${r.state}:${r.installed}`).join(",")} />); });
};

const updateButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => /^(Update Claude Code|Updating)$/.test(b.textContent ?? "")) ?? null;
const restartButton = () => host.querySelector<HTMLButtonElement>('[data-restart-handoff="trantor"]');

describe("AgentCliBanner", () => {
  it("shows one banner naming installed, needed and the feature that needs it", async () => {
    await mount([claude({})]);
    const banner = host.querySelector('[data-agent-cli-banner="claude"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Claude Code 2.1.100 is older than Trantor needs (2.1.215)");
    expect(banner?.textContent).toContain("the Mode menu needs 2.1.326");
  });

  it("stays quiet for ok, newer than verified and not installed", async () => {
    await mount([claude({ installed: "2.1.326", state: "ok", reason: null, features: [{ name: "Mode menu", verifiedFrom: "2.1.326", verifiedTo: "2.1.326", why: "", inRange: true }] })]);
    expect(host.querySelector("[data-agent-cli-banner]")).toBeNull();
    await mount([claude({ installed: "2.1.400", state: "newer_than_verified", reason: "newer than the newest release Trantor has verified (2.1.326)" })]);
    expect(host.querySelector("[data-agent-cli-banner]")).toBeNull();
    await mount([claude({ installed: null, state: "not_installed", reason: null })]);
    expect(host.querySelector("[data-agent-cli-banner]")).toBeNull();
  });

  it("keeps a small copy command beside the Update button, and the click copies without running anything", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([claude({})]);
    expect(updateButton()).not.toBeNull();
    const copy = host.querySelector<HTMLButtonElement>('button[data-agent-cli-copy="claude update"]');
    expect(copy?.textContent).toContain("copy command");
    await act(async () => { copy?.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("claude update");
    expect(invokes.filter(i => i.cmd === "agent_cli_update")).toHaveLength(0);
  });

  it("says to update the way it was installed when no update command is confirmed, with no Update button", async () => {
    await mount([claude({ updateCommand: null })]);
    expect(host.textContent).toContain("update it the way you installed it");
    expect(updateButton()).toBeNull();
    expect(host.querySelector('button[data-agent-cli-copy]')).toBeNull();
  });

  it("dismisses the banner for this session", async () => {
    await mount([claude({})]);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')?.click());
    expect(host.querySelector("[data-agent-cli-banner]")).toBeNull();
  });

  it("runs the CLI's own updater on the click, is busy while it runs, then names both versions", async () => {
    let resolveUpdate: ((v: AgentCliUpdate) => void) | undefined;
    await mount([claude({})], { update: () => new Promise<AgentCliUpdate>(resolve => { resolveUpdate = resolve; }) });
    await act(async () => { updateButton()?.click(); });
    const busy = updateButton();
    expect(busy?.textContent).toContain("Updating");
    expect(busy?.getAttribute("aria-busy")).toBe("true");
    expect(invokes.filter(i => i.cmd === "agent_cli_update")).toEqual([{ cmd: "agent_cli_update", args: { cli: "claude" } }]);
    await act(async () => { resolveUpdate?.(updateOk); });
    expect(host.querySelector('[data-agent-cli-updated="claude"]')?.textContent)
      .toContain("Updated 2.1.100 to 2.1.326");
    expect(updateButton()).toBeNull();
  });

  it("a failed update shows the output's last lines and keeps the copy command", async () => {
    await mount([claude({})], { update: () => ({ ok: false, before: "2.1.100", after: "2.1.100", output: "line 1\nline 2\nline 3\nline 4" }) });
    await act(async () => { updateButton()?.click(); });
    const failed = host.querySelector('[data-agent-cli-failed="claude"]');
    expect(failed?.textContent).toContain("The update did not succeed");
    expect(failed?.textContent).toContain("line 4");
    expect(failed?.textContent).toContain("line 2");
    expect(failed?.textContent).not.toContain("line 1");
    expect(host.querySelector('button[data-agent-cli-copy="claude update"]')).not.toBeNull();
  });

  it("after a successful update, lists the sessions still on the old binary with their restart paths", async () => {
    await mount([claude({})], { update: () => updateOk, sessions: () => stale });
    await act(async () => { updateButton()?.click(); });
    const list = host.querySelector('[data-agent-cli-sessions="claude"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("trantor");
    expect(list?.textContent).toContain("orchestrator");
    expect(list?.textContent).toContain("started before the update");
    expect(list?.textContent).toContain("crebral");
    expect(list?.textContent).toContain("codex");
    expect(list?.textContent).toContain("may be on the old version");
    expect(list?.textContent).toContain("restart it from Agents");
    expect(list?.textContent).toContain("not checked on netcup");
  });

  it("restarts one session with one handoff per confirmed click — never more than the one clicked", async () => {
    const handoffs: Array<{ project: string; reason: string }> = [];
    await mount([claude({})], {
      update: () => updateOk,
      sessions: () => stale,
      handoffNow: call => { handoffs.push(call); return "ok"; },
    });
    await act(async () => { updateButton()?.click(); });
    const restart = () => restartButton();
    await act(async () => { restart()?.click(); });
    expect(restart()?.textContent).toContain("Confirm: restart");
    expect(handoffs).toEqual([]);
    await act(async () => { restart()?.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(handoffs).toEqual([{ project: "trantor", reason: "clicked" }]);
    expect(restart()?.textContent).toContain("Restarted");
    await act(async () => { restart()?.click(); });
    expect(handoffs).toEqual([{ project: "trantor", reason: "clicked" }]);
  });
});

describe("featureInRange", () => {
  it("answers per feature and cli from the compatibility rows", () => {
    const ok = claude({ installed: "2.1.326", state: "ok", reason: null, features: [{ name: "Mode menu", verifiedFrom: "2.1.326", verifiedTo: "2.1.326", why: "", inRange: true }] });
    expect(featureInRange([ok], "Mode menu")).toBe(true);
    expect(featureInRange([ok], "Some other feature")).toBe(false);
    expect(featureInRange([claude({})], "Mode menu")).toBe(false);
    expect(featureInRange([], "Mode menu")).toBe(false);
  });
});
