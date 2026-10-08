// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrewControls } from "./CrewControls";
import type { PaneTarget } from "./paneTargets";
import { availableAgent, quotaLabel, createCrewApi, type CrewApi, type CrewCatalog, type CrewResult, type SeatWhy } from "./crewControlApi";

// SAFETY: React reads this test-only flag from globalThis.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const catalog: CrewCatalog = {
  agents: ["glm", "codex", "kimi", "deepseek"].map(id => ({ id, label: id, launch: id === "glm" ? "glm:zai-coding-plan" : id,
    installed: true, enabled: true, isDefault: false, cli: id, homepage: "", install: "" })),
  balances: [{ provider: "zai", ok: true, remainingPct: 60 }, { provider: "codex", ok: true, remainingPct: 80 }, { provider: "deepseek", ok: true, remaining: 0 }],
};
const target = (name: string): PaneTarget => ({ key: name, agent: name, label: name, brand: name, session: `${name}:trantor`, online: true, isOrchestrator: false });
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
    const button = [...document.querySelectorAll("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
  };
  const mount = async (api: CrewApi, onChanged = vi.fn()) => {
    await act(async () => root.render(<CrewControls project="trantor" targets={[target("glm")]} onSelect={vi.fn()} api={api} onChanged={onChanged} />));
  };
  it("disables actions when seat state cannot be read", async () => {
    const api = fakeApi(); api.why = vi.fn(async () => { throw new Error("checkout unavailable"); });
    await mount(api);
    expect(host.querySelector("[title*=unavailable]")?.getAttribute("title")).toContain("checkout unavailable");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(true);
    expect(api.action).not.toHaveBeenCalled();
  });
  it("offers Stop and quota-aware Swap for live seats, but no Start", async () => {
    await mount(fakeApi()); await click("glm actions");
    expect(document.body.textContent).toContain("Stop"); expect(document.body.textContent).not.toContain("Start");
    await click("Swap to ▸");
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(options.find(o => o.textContent?.startsWith("codex"))?.disabled).toBe(false);
    expect(options.find(o => o.textContent?.startsWith("deepseek"))?.disabled).toBe(true);
    expect(options.some(o => o.textContent?.startsWith("glm"))).toBe(false);
  });
  it.each(["no-runner", "dead-auth", "dead-quota", "dead-crash"])("offers Start for %s", async name => {
    const api = fakeApi(name); await mount(api); await click("glm actions");
    expect(document.body.textContent).toContain("Start"); expect(document.body.textContent).not.toContain("Stop");
  });
  it("shows the parked reason and reset beside Start, using the catalog launch spec", async () => {
    const api = fakeApi("parked"); await mount(api);
    expect(host.querySelector("[title^=parked]")?.getAttribute("title")).toBe("parked · exhausted · resets in 2h");
    await click("glm actions");
    await click("Start");
    expect(api.action).toHaveBeenCalledWith("trantor", "up", "glm:zai-coding-plan", undefined);
    expect(host.textContent).toContain("Started");
  });
  it("shows progress, blocks repeat actions, refreshes state and keeps a failure reason inline", async () => {
    const api = fakeApi(); const changed = vi.fn();
    let finish!: (value: CrewResult) => void;
    api.action = vi.fn(() => new Promise<CrewResult>(resolve => { finish = resolve; }));
    await mount(api, changed); await click("glm actions"); await click("Stop");
    expect(host.textContent).toContain("Stopping…");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(true);
    await act(async () => finish({ ok: false, action: "down", seat: "glm", reason: "bad key, glm left running" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("glm · bad key, glm left running");
    expect(api.why).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledOnce();
  });
  it("swaps to the selected catalog spec and reports the destination", async () => {
    const api = fakeApi(); await mount(api); await click("glm actions");
    await click("Swap to ▸"); await click("codex · 80% left");
    expect(api.action).toHaveBeenCalledWith("trantor", "swap", "glm", "codex");
    expect(host.textContent).toContain("Swapped to codex");
  });
  it("reports rejected CLI calls and leaves the controls usable", async () => {
    const api = fakeApi(); api.action = vi.fn(async () => { throw new Error("CLI missing"); });
    await mount(api); await click("glm actions"); await click("Stop");
    expect(host.textContent).toContain("CLI missing");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="glm actions"]')?.disabled).toBe(false);
  });
  it("offers a seat when the crew is empty without starting it until Start is clicked", async () => {
    const api = fakeApi("no-runner");
    await act(async () => root.render(<CrewControls project="trantor" targets={[]} onSelect={vi.fn()} api={api} onChanged={vi.fn()} />));
    await click("Add seat"); await click("codex · 80% left");
    expect(api.action).not.toHaveBeenCalled();
    await click("codex actions");
    expect(document.body.textContent).toContain("Start");
  });
  it("refreshes state after Stop without waiting for the peer poll", async () => {
    const api = fakeApi(); api.why = vi.fn().mockResolvedValueOnce(state("live")).mockResolvedValue(state("no-runner"));
    await mount(api); await click("glm actions"); await click("Stop");
    expect(host.textContent).toContain("Stopped"); await click("glm actions"); expect(document.body.textContent).toContain("Start");
  });
  it("opens from the tab context menu and closes with Escape", async () => {
    await mount(fakeApi());
    await act(async () => host.querySelector("button")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("renders twelve seats once in a scrolling strip and clears the single outcome", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<CrewControls project="trantor" targets={Array.from({ length: 12 }, (_, i) => target(`seat${i}`))} onSelect={vi.fn()} onChanged={vi.fn()} api={fakeApi()} />));
      expect(host.querySelector('[aria-label="Seat tabs"]')?.className).toContain("overflow-x-auto");
      expect(host.querySelectorAll(".tr-dot")).toHaveLength(12);
      const strip = host.querySelector('[aria-label="Seat tabs"]');
      const add = host.querySelector('[aria-label="Add seat"]');
      expect(strip?.contains(add)).toBe(false);
      expect(strip?.parentElement).toBe(add?.parentElement);
      await click("seat0 actions"); await click("Stop");
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(5100));
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it.each(["live", "parked", "no-runner"])("renders a %s dot on the tab", async name => {
    await mount(fakeApi(name));
    const dot = host.querySelector(".tr-dot")!;
    expect(dot.className).toContain(name === "parked" ? "bg-tr-muted/50" : name === "live" ? "bg-tr-ok" : "border-tr-muted");
  });

  it("pulses only the working dot and uses the parked tooltip", async () => {
    const api = fakeApi();
    await act(async () => root.render(<CrewControls project="trantor" targets={[{ ...target("glm"), status: "working" }]} onSelect={vi.fn()} onChanged={vi.fn()} api={api} />));
    expect(host.querySelector(".tr-dot-pulse")).toBeTruthy();
    api.why = vi.fn(async () => ({ state: "parked", why: "PARKED (stalled)", advice: "resumes (in 15m)" }));
    await act(async () => root.render(<CrewControls project="trantor" targets={[{ ...target("glm"), status: "working" }]} onSelect={vi.fn()} onChanged={vi.fn()} api={{ ...api }} />));
    expect(host.querySelector(".tr-dot-pulse")).toBeNull();
    expect(host.querySelector('[title="parked · stalled · resets in 15m"]')).toBeTruthy();
  });
  it("shows exhausted reset times and disables exhausted subscription windows", () => {
    const balance = { provider: "codex", ok: true, remainingPct: 0, resetTime: Date.now() + 900000 };
    expect(quotaLabel(balance)).toBe("0% left · resets in 15m");
    expect(availableAgent(catalog.agents[1], [balance])).toBe(false);
    expect(availableAgent(catalog.agents[1], [{ provider: "codex", ok: true, windows: [{ usedPct: 100, resetsAt: new Date(Date.now() + 900000).toISOString() }] }])).toBe(false);
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
