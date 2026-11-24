// @vitest-environment happy-dom
// #14030: the banner shows only below the minimum; every other state stays quiet. The button
// copies the CLI's own update command (never runs an updater), and × dismisses for this session.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { AgentCliCompatibility } from "../../shared/api/client";
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

const mount = async (reports: AgentCliCompatibility[]) => {
  mockIPC(cmd => (cmd === "agent_cli_compatibility" ? reports : null));
  await act(async () => { root.render(<AgentCliBanner key={reports.map(r => `${r.cli}:${r.state}:${r.installed}`).join(",")} />); });
};

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

  it("copies the CLI's own update command instead of running an updater", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([claude({})]);
    const btn = host.querySelector<HTMLButtonElement>('button[title="claude update"]');
    expect(btn?.textContent).toContain("Copy update command");
    await act(async () => { btn?.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("claude update");
  });

  it("says to update the way it was installed when no update command is confirmed", async () => {
    await mount([claude({ updateCommand: null })]);
    expect(host.textContent).toContain("update it the way you installed it");
    expect(host.querySelector('button[title="claude update"]')).toBeNull();
  });

  it("dismisses the banner for this session", async () => {
    await mount([claude({})]);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')?.click());
    expect(host.querySelector("[data-agent-cli-banner]")).toBeNull();
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
