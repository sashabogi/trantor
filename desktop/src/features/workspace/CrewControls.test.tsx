// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrewControls, CrewSeatRow } from "./CrewControls";
import { createCrewApi, type CrewApi, type CrewCatalog, type CrewResult, type SeatWhy } from "./crewControlApi";

// SAFETY: React reads this test-only flag from globalThis.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const catalog: CrewCatalog = {
  agents: ["glm", "codex", "kimi", "deepseek"].map(id => ({ id, label: id, launch: id === "glm" ? "glm:zai-coding-plan" : id,
    installed: true, enabled: true, isDefault: false, cli: id, homepage: "", install: "" })),
  balances: [{ provider: "zai", ok: true, remainingPct: 60 }, { provider: "codex", ok: true, remainingPct: 80 }, { provider: "deepseek", ok: true, remaining: 0 }],
};
const state = (name: string): SeatWhy => ({ state: name, why: "runner alive; PARKED (exhausted) holding 1 message", advice: "parked until 12:00 (in 2h) — it resumes itself" });
function fakeApi(initial = "live"): CrewApi {
  return { catalog: vi.fn(async () => catalog), why: vi.fn(async () => state(initial)),
    action: vi.fn(async (_p, action, seat) => ({ ok: true, action, seat, to: "codex" })) };
}

describe("Workspace crew controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(b => b.textContent === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
  };
  const mount = async (api: CrewApi, onChanged = vi.fn()) => {
    await act(async () => root.render(<CrewSeatRow project="trantor" seat="glm" catalog={catalog} api={api} onChanged={onChanged} />));
  };
  it("disables actions when seat state cannot be read", async () => {
    const api = fakeApi(); api.why = vi.fn(async () => { throw new Error("checkout unavailable"); });
    await mount(api);
    expect(host.textContent).toContain("checkout unavailable");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(true);
    expect(api.action).not.toHaveBeenCalled();
  });
  it("offers Stop and quota-aware Swap for live seats, but no Start", async () => {
    await mount(fakeApi()); await click("Actions");
    expect(host.textContent).toContain("Stop"); expect(host.textContent).not.toContain("Start");
    const options = [...host.querySelectorAll("option")];
    expect(options.find(o => o.value === "codex")?.disabled).toBe(false);
    expect(options.find(o => o.value === "deepseek")?.disabled).toBe(true);
    expect(options.some(o => o.value === "glm:zai-coding-plan")).toBe(false);
  });
  it.each(["no-runner", "dead-auth", "dead-quota", "dead-crash"])("offers Start for %s", async name => {
    const api = fakeApi(name); await mount(api); await click("Actions");
    expect(host.textContent).toContain("Start"); expect(host.textContent).not.toContain("Stop");
  });
  it("shows the parked reason and reset beside Start, using the catalog launch spec", async () => {
    const api = fakeApi("parked"); await mount(api);
    expect(host.textContent).toContain("exhausted · resets in 2h");
    await click("Start");
    expect(api.action).toHaveBeenCalledWith("trantor", "up", "glm:zai-coding-plan", undefined);
    expect(host.textContent).toContain("Started");
  });
  it("shows progress, blocks repeat actions, refreshes state and keeps a failure reason inline", async () => {
    const api = fakeApi(); const changed = vi.fn();
    let finish!: (value: CrewResult) => void;
    api.action = vi.fn(() => new Promise<CrewResult>(resolve => { finish = resolve; }));
    await mount(api, changed); await click("Actions"); await click("Stop");
    expect(host.textContent).toContain("Stopping…");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(true);
    await act(async () => finish({ ok: false, action: "down", seat: "glm", reason: "bad key, glm left running" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("bad key, glm left running");
    expect(api.why).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledOnce();
  });
  it("swaps to the selected catalog spec and reports the destination", async () => {
    const api = fakeApi(); await mount(api); await click("Actions");
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "codex"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(api.action).toHaveBeenCalledWith("trantor", "swap", "glm", "codex");
    expect(host.textContent).toContain("Swapped to codex");
  });
  it("reports rejected CLI calls and leaves the controls usable", async () => {
    const api = fakeApi(); api.action = vi.fn(async () => { throw new Error("CLI missing"); });
    await mount(api); await click("Actions"); await click("Stop");
    expect(host.textContent).toContain("CLI missing");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(false);
  });
  it("offers a seat when the crew is empty without starting it until Start is clicked", async () => {
    const api = fakeApi("no-runner");
    await act(async () => root.render(<CrewControls project="trantor" seats={[]} api={api} onChanged={vi.fn()} />));
    await click("Add seat"); await click("codex · 80% left");
    expect(api.action).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Start");
  });
  it("refreshes state after Stop without waiting for the peer poll", async () => {
    const api = fakeApi(); api.why = vi.fn().mockResolvedValueOnce(state("live")).mockResolvedValue(state("no-runner"));
    await mount(api); await click("Actions"); await click("Stop");
    expect(host.textContent).toContain("Stopped"); expect(host.textContent).toContain("Start");
  });
});

describe("action to installed CLI mapping (fake run_cli_json)", () => {
  it("passes exact scoped args and reads both catalog sources", async () => {
    const run = vi.fn(async (_project: string, args: string[]) => {
      if (args[0] === "agent-settings") return JSON.stringify({ agents: catalog.agents });
      if (args[0] === "balances") return JSON.stringify({ balances: catalog.balances });
      if (args[0] === "seat-why") return JSON.stringify(state("parked"));
      return JSON.stringify({ ok: true, action: args[0], seat: args[1] });
    });
    const api = createCrewApi(run);
    expect(await api.catalog("trantor")).toEqual(catalog);
    await api.why("trantor", "glm"); await api.action("trantor", "up", "glm:zai-coding-plan");
    await api.action("trantor", "down", "glm"); await api.action("trantor", "swap", "glm", "codex");
    expect(run.mock.calls).toEqual([
      ["trantor", ["agent-settings", "status", "--json"]], ["trantor", ["balances", "--json"]],
      ["trantor", ["seat-why", "glm", "--json"]], ["trantor", ["up", "glm:zai-coding-plan", "--json"]],
      ["trantor", ["down", "glm", "--json"]], ["trantor", ["swap", "glm", "codex", "--json"]],
    ]);
    await expect(api.action("trantor", "down", "")).rejects.toThrow();
    await expect(api.action("trantor", "swap", "glm")).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(6);
  });
});
