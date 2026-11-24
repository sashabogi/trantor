// @vitest-environment happy-dom
// #13991: the screen renders real reads, says "no meter", drives panels from the range, and exports CSV.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient, type BalancesReport, type Learning } from "../../../shared/api/client";
import { UsageScreen } from "./index";
import { dayKey } from "./model";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const today = dayKey(Date.now());
const longAgo = "2020-01-01";
const learning = (): Learning => ({
  totals: { lessons: 0, guardrails: 0, turns: 0, failures: 0, failRate: 0, models: 0 },
  lessons: { global: [], byAgent: {}, byProject: {}, projects: ["trantor"] },
  agents: [{ agent: "codex", turns: 0, failures: 0, failRate: 0, models: ["m"], lastFailure: null,
    // the hub's per-day series, which the frozen type omits
    ...{ series: { failRate: [{ day: today, turns: 12, failures: 3 }, { day: longAgo, turns: 50, failures: 0 }] } } }],
  agentsByProject: {}, models: [], modelsByProject: {},
});

const report: BalancesReport = { ts: Date.now(), lowCount: 0, stale: false, entries: [
  { provider: "kimi", label: "Kimi", kind: "quota", ok: true, low: false, remainingPct: null, detail: "usage unread" },
  { provider: "deepseek", label: "DeepSeek", kind: "prepaid", ok: true, low: false, remaining: 36 },
] };

function client(): HubClient {
  const c = new HubClient("http://127.0.0.1:1");
  vi.spyOn(c, "economics").mockResolvedValue({ windows: {} });
  vi.spyOn(c, "learning").mockResolvedValue(learning());
  vi.spyOn(c, "tasks").mockResolvedValue([]);
  vi.spyOn(c, "peers").mockResolvedValue([]);
  vi.spyOn(c, "balances").mockResolvedValue(report);
  return c;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { mockIPC(cmd => (cmd === "machine_id" ? "m1" : undefined)); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

async function mount(project = "") {
  await act(async () => { root.render(<UsageScreen client={client()} project={project} onNavigate={() => {}} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const click = (label: string) => act(() => { [...host.querySelectorAll("button")].find(b => b.textContent === label)?.click(); });

describe("UsageScreen", () => {
  it("renders no meter for Kimi and a balance for DeepSeek", async () => {
    await mount();
    expect(host.querySelector('[data-plan="kimi"]')?.textContent).toContain("no meter");
    expect(host.querySelector('[data-plan="deepseek"]')?.textContent).toContain("$36.0");
  });

  it("drives the turns tile from the range pills", async () => {
    await mount();
    const turns = () => host.querySelector('[data-kpi="turns"]')?.textContent ?? "";
    expect(turns()).toContain("12");
    click("All time");
    expect(turns()).toContain("62");
    click("Today");
    expect(turns()).toContain("12");
  });

  it("drops the API value tile and marks economics n/a at ranges the hub does not serve", async () => {
    await mount();
    expect(host.querySelector('[data-kpi="api"]')).toBeNull();
    expect(host.querySelector('[data-kpi="spend"]')?.textContent).toContain("n/a at this range");
  });

  it("switches the daily chart to a table", async () => {
    await mount();
    click("View as table");
    expect(host.querySelector("table")?.textContent).toContain("DAY");
  });

  it("opens fleet-wide even when a project is active (#13984 drill)", async () => {
    await mount("trantor");
    expect(host.querySelector("[data-filter]")).toBeNull();
  });

  it("exports the by-agent CSV through a download", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => { if (b instanceof Blob) created.push(b); return "blob:x"; };
    URL.revokeObjectURL = () => {};
    await mount();
    const exportBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Export CSV" && !b.disabled);
    await act(async () => { exportBtn?.click(); });
    expect(created).toHaveLength(1);
    expect(await created[0].text()).toContain("AGENT,VENDOR,MODELS,MACHINES,TURNS");
  });
});
