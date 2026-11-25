// @vitest-environment happy-dom
// #13986: queue ranking with project identity, per-project seat tabs, the grid toggle, and hold actions hitting the hub.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { DashboardScreen } from "./index";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const BODIES = new Map<string, unknown>([
  ["/tasks", { tasks: [
    { id: 11, project: "trantor", title: "Seat start errors", status: "doing", assignee: "kimi-9", updated: now - 5 * 60_000 },
    { id: 12, project: "ibkr", title: "Exact-price markers", status: "testing", updated: now - 3_600_000 },
  ] }],
  ["/peers", { peers: [
    { session: "kimi-9:trantor", project: "trantor", status: "working · card", lastSeen: now, online: true, model: "kimi", machine: "netcup" },
    { session: "glm-5:trantor", project: "trantor", status: "idle", lastSeen: now, online: true, model: "glm-5.3", machine: "netcup" },
    { session: "codex-2:crebral-cortex", project: "crebral-cortex", status: "working", lastSeen: now, online: true },
  ] }],
  ["/holds", { holds: [{ id: 7, project: "trantor", file: "panes.rs", session: "kimi-9:trantor", other: "glm-5:trantor", status: "pending", ts: now - 360_000 }] }],
  ["/proposals", { proposals: [{ id: 3, session: "glm-5:trantor", project: "trantor", scope: "push to seat branch", condition: "c", exclusions: "e", status: "pending", ts: now - 120_000 }], pendingCount: 1 }],
  ["/inbox", { messages: [{ id: 5, ts: now - 60_000, from: "kimi-9:trantor", to: "sasha", project: "trantor", text: "keep the tab for 60 s?" }], cursor: 5 }],
  ["/economics", { windows: { lifetime: { calls: 10, tokens_in: 1, tokens_out: 1, cost_usd: 1.5, opus_equiv_usd: 40, saved_usd: 38.5 } } }],
  ["/machines/health", { machines: [{ machine: "netcup", cpuPct: 8, memUsed: 35, memTotal: 63, ts: now }], staleAfterMs: 90_000 }],
]);

const calls: { method: string; path: string; body: string | null }[] = [];
const client = new HubClient("http://hub.test", async ({ method, path, body }) => {
  calls.push({ method, path, body });
  const hit = [...BODIES].find(([p]) => path.startsWith(p));
  return { status: 200, body: JSON.stringify(method === "POST" ? { ok: true } : hit?.[1] ?? {}) };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "identity_name") return "sasha";
    if (command === "known_projects") return ["attic", "crebral-cortex", "ibkr", "trantor"];
    if (command === "local_sessions") return [];
    if (command === "orch_restorables") return [];
    if (command === "dismissed_sessions_list") return "[]";
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const navigate = vi.fn();
const mount = async () => {
  await act(async () => { root.render(<DashboardScreen client={client} project="trantor" onNavigate={navigate} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const byText = (sel: string, text: string) => [...host.querySelectorAll(sel)].find(e => e.textContent?.includes(text)) ?? null;

describe("Dashboard", () => {
  it("ranks the queue (hold, proposal, question, drill) and names each item's project", async () => {
    await mount();
    const rows = [...host.querySelectorAll('[data-kind]')];
    expect(rows.map(r => r.getAttribute("data-kind"))).toEqual(["hold", "proposal", "message", "testing"]);
    expect(rows.map(r => r.querySelector("[data-project-tile]")?.getAttribute("data-project-tile")))
      .toEqual(["trantor", "trantor", "trantor", "ibkr"]);
    expect(rows[0].textContent).toContain("#11");
    expect(rows[0].textContent).toContain("kimi-9");
  });

  it("offers one tab per project with live seats and filters the rows", async () => {
    await mount();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map(t => t.textContent?.replace(/\s+/g, " ").trim());
    expect(tabs).toEqual(["All 3", "CCcrebral-cortex 1", "TRtrantor 2"]); // the monogram tile precedes each name
    expect(host.querySelectorAll("[data-seat]").length).toBe(3);
    await click(byText('[role="tab"]', "crebral-cortex"));
    expect([...host.querySelectorAll("[data-seat]")].map(r => r.getAttribute("data-seat"))).toEqual(["codex-2"]);
  });

  it("switches Working now to one tile per seat in the grid view", async () => {
    await mount();
    expect(host.querySelector("article")).toBeNull();
    await click(byText('button[aria-pressed]', "Grid"));
    const tiles = [...host.querySelectorAll("article")].map(a => a.getAttribute("aria-label"));
    expect(tiles).toEqual(["codex-2", "glm-5", "kimi-9"]);
    expect(host.querySelector('button[aria-label="Focus kimi-9 full window"]')).not.toBeNull();
  });

  it("counts only actionable work in the headline and never prints raw session ids", async () => {
    await mount();
    expect(host.querySelector("main p")?.textContent).toContain("3 things need you. 2 agents are moving.");
    expect(byText("h2", "Needs you")?.textContent).toBe("Needs you 3");
    expect(host.querySelector("h3")?.textContent).toBe("Waiting for a drill 1");
    expect(host.textContent).not.toContain("kimi-9:trantor");
    expect(host.textContent).not.toContain("codex-2:crebral-cortex");
  });

  it("regroups by project and by seat, remembering the layout", async () => {
    await mount();
    await click(byText('button[aria-pressed]', "By project"));
    expect(localStorage.getItem("trantor.v2.dashboard.layout")).toBe("project");
    expect([...host.querySelectorAll("main section[aria-label]")].map(s => s.getAttribute("aria-label"))).toEqual(["crebral-cortex", "ibkr", "trantor"]);
    await click(byText('button[aria-pressed]', "By agent"));
    expect(localStorage.getItem("trantor.v2.dashboard.layout")).toBe("agent");
    expect([...host.querySelectorAll("main section[aria-label]")].map(s => s.getAttribute("aria-label"))).toEqual(["codex-2", "glm-5", "ibkr reviews", "kimi-9"]);
  });

  it("keeps inactive projects behind a remembered Show all control", async () => {
    await mount();
    expect(byText("aside[aria-label='Projects'] button", "attic")).toBeNull();
    await click(byText("button", "Show all 1"));
    expect(byText("aside[aria-label='Projects'] button", "attic")).not.toBeNull();
    expect(localStorage.getItem("trantor.v2.dashboard.projects.show-all")).toBe("true");
  });

  it("sends go/no-go and proposal decisions to the hub and drops the row", async () => {
    await mount();
    await click(byText("button", "kimi-9 first"));
    const hold = calls.find(c => c.path === "/hold/decide");
    expect(hold && JSON.parse(hold.body ?? "{}")).toMatchObject({ id: 7, project: "trantor", status: "go" });
    expect(host.querySelector('[data-kind="hold"]')).toBeNull();
    await click(byText('[data-kind="proposal"] button', "Approve"));
    const prop = calls.find(c => c.path === "/proposal/decide");
    expect(prop && JSON.parse(prop.body ?? "{}")).toMatchObject({ id: 3, status: "approved" });
  });

  it("gives every icon button a label and a title; swap and stop open the Agents screen instead of sitting dead (#14268)", async () => {
    await mount();
    const iconOnly = [...host.querySelectorAll("button")].filter(b => !b.textContent?.trim());
    expect(iconOnly.length).toBeGreaterThan(5);
    for (const btn of iconOnly) {
      expect(btn.getAttribute("aria-label")).toBeTruthy();
      expect(btn.getAttribute("title")).toBeTruthy();
    }
    for (const b of host.querySelectorAll<HTMLButtonElement>("button")) expect(b.title).not.toMatch(/does not exist yet|not wired/);
    expect(host.querySelector('button[aria-label="Stop kimi-9"]')).toBeNull();
    await click(host.querySelector('button[aria-label="Manage kimi-9"]'));
    expect(navigate).toHaveBeenCalledWith("agents", "trantor");
    await click(host.querySelector('button[aria-label="Watch kimi-9 live"]'));
    expect(navigate).toHaveBeenCalledWith("workspace", "trantor");
  });

  it("keeps no placeholder buttons: no Compare both changes, no unwired grid text (#14268)", async () => {
    await mount();
    expect(byText("button", "Compare both changes")).toBeNull();
    await click(byText('button[aria-pressed]', "Grid"));
    expect(host.textContent).not.toMatch(/not wired/i);
    expect(host.textContent).toContain("use Watch live");
  });

  it("arrow keys move between the project tabs and Escape clears the project filter (#14268)", async () => {
    await mount();
    const all = [...host.querySelectorAll('[role="tab"]')].find(e => e.textContent?.includes("All"));
    if (!all) throw new Error("All tab not found");
    await act(async () => { all.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("tabindex")).toBe("0");
    expect(tabs[0].getAttribute("tabindex")).toBe("-1");
    const input = host.querySelector<HTMLInputElement>("#v2-dash-filter");
    if (!input) throw new Error("filter input not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "ibkr");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("ibkr");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(input.value).toBe("");
  });
});
