// @vitest-environment happy-dom
// #v2-F: the 2.0 footer shows the classic chip data, machine health, and the hub state; the wired
// version reads the real /balances and /machines/health endpoints.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient, type BalancesReport } from "../../shared/api/client";
import { BottomBar, PlansBar } from "./BottomBar";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GiB = 2 ** 30;
const report = (): BalancesReport => ({ ts: Date.now(), lowCount: 0, stale: false, entries: [
  { provider: "deepseek", label: "DeepSeek", kind: "prepaid", ok: true, low: false, remaining: 14 },
] });
const machines = () => ({ machines: [{ machine: "netcup", cpuPct: 8, memUsed: 35 * GiB, memTotal: 63 * GiB, ts: Date.now() }], staleAfterMs: 90_000 });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

describe("PlansBar", () => {
  it("renders a plan chip, the machine line and hub connected", () => {
    const onOpenUsage = vi.fn();
    act(() => root.render(<PlansBar report={report()} failure={null} refreshError={null} machines={machines()} spinning={false} onRefresh={() => {}} onOpenUsage={onOpenUsage} />));
    const footer = host.querySelector('footer[aria-label="Plans and balances"]');
    expect(footer).not.toBeNull();
    const chip = host.querySelector<HTMLButtonElement>("[data-chip]");
    expect(chip?.textContent).toContain("DeepSeek");
    expect(chip?.textContent).toContain("$14");
    act(() => chip?.click());
    expect(onOpenUsage).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-machine="netcup"]')?.textContent).toContain("CPU 8% · 35/63 GB");
    expect(host.textContent).toContain("hub connected");
  });

  it("says when usage is unavailable instead of inventing numbers", () => {
    act(() => root.render(<PlansBar report={null} failure="not enrolled" refreshError={null} machines={null} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("usage unavailable: not enrolled");
    expect(host.textContent).toContain("hub unreachable");
    expect(host.querySelector("[data-chip]")).toBeNull();
  });

  it("says how old the numbers are beside the chips AND in the tooltip when the snapshot is stale (#14055)", () => {
    const old = { ...report(), ts: Date.now() - 35 * 60 * 1000 };
    act(() => root.render(<PlansBar report={old} failure={null} refreshError={null} machines={null} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    const why = host.querySelector<HTMLElement>("[data-bar-why]");
    expect(why?.textContent).toBe("as of 35m ago");
    expect(why?.getAttribute("title")).toContain("as of 35m ago");
    expect(host.querySelector<HTMLButtonElement>("[data-chip]")?.getAttribute("title")).toContain("as of 35m ago");
    expect(host.querySelector<HTMLElement>("[data-bar-chips]")?.style.opacity).toBe("0.55");
  });

  it("shows the refresh error beside the chips instead of only dimming (#14055)", () => {
    act(() => root.render(<PlansBar report={report()} failure={null} refreshError="trantor balances: Kimi 401 unauthorized" machines={null} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    const why = host.querySelector<HTMLElement>("[data-bar-why]");
    expect(why?.textContent).toBe("refresh failed: trantor balances: Kimi 401 unauthorized");
    expect(why?.getAttribute("title")).toContain("Kimi 401 unauthorized");
  });

  it("keeps a long refresh error on one bounded line, whole message in the tooltip", () => {
    const blob = `provider failed\n${"x".repeat(400)}`;
    act(() => root.render(<PlansBar report={report()} failure={null} refreshError={blob} machines={null} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    const why = host.querySelector<HTMLElement>("[data-bar-why]");
    expect((why?.textContent ?? "").length).toBeLessThanOrEqual(120);
    expect(why?.getAttribute("title")).toContain("provider failed");
    expect(why?.getAttribute("title")).toContain("xxx");
  });

  it("keeps the chips in their own scrolling lane and the machine readout non-shrinking (#13984 drill)", () => {
    act(() => root.render(<PlansBar report={report()} failure={null} refreshError={null} machines={machines()} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    const chips = host.querySelector<HTMLElement>("[data-bar-chips]");
    const readout = host.querySelector<HTMLElement>("[data-bar-machines]");
    expect(chips?.style.minWidth).toMatch(/^0(px)?$/);
    expect(chips?.style.overflowX).toBe("auto");
    expect(chips?.style.flexWrap).toBe("nowrap");
    expect(readout?.style.flex).toMatch(/^(none|0 0 auto)$/);
    expect(chips?.contains(readout)).toBe(false);
  });

  it("has a labelled refresh control", () => {
    const onRefresh = vi.fn();
    act(() => root.render(<PlansBar report={report()} failure={null} refreshError={null} machines={null} spinning={false} onRefresh={onRefresh} onOpenUsage={() => {}} />));
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh plans and balances"]');
    expect(btn?.title).toBe("Re-query every provider now");
    act(() => btn?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("BottomBar wiring", () => {
  it("reads balances by machine id and machine health from the hub", async () => {
    const paths: string[] = [];
    mockIPC((command, args) => {
      if (command === "machine_id") return "MacBook-Test";
      if (command !== "hub_request") return null;
      // SAFETY: hub_request args are { base, method, path, body } by the client's own transport.
      const { path } = args as { path: string };
      paths.push(path);
      if (path === "/machines/health") return { status: 200, body: JSON.stringify(machines()) };
      return { status: 200, body: JSON.stringify(report()) };
    });
    await act(async () => { root.render(<BottomBar client={new HubClient("http://127.0.0.1:4477")} onOpenUsage={() => {}} />); });
    expect(paths).toContain("/balances?machine=MacBook-Test");
    expect(paths).toContain("/machines/health");
    expect(host.querySelector("[data-chip]")?.textContent).toContain("DeepSeek");
    expect(host.querySelector('[data-machine="netcup"]')).not.toBeNull();
  });

  // #14055 — a snapshot over 10 minutes old triggers the CLI refetch on mount; when that refresh
  // FAILS, the error is kept (never swallowed) and the bar says so beside the chips.
  it("keeps the balances_refresh failure and shows it when the mount refetch fails", async () => {
    const staleOnArrival = { ...report(), ts: Date.now() - 20 * 60 * 1000 };
    mockIPC((command) => {
      if (command === "machine_id") return "MacBook-Test";
      if (command === "balances_refresh") throw new Error("trantor balances: Kimi 401 unauthorized");
      if (command === "hub_request") return { status: 200, body: JSON.stringify(staleOnArrival) };
      return null;
    });
    await act(async () => { root.render(<BottomBar client={new HubClient("http://127.0.0.1:4477")} onOpenUsage={() => {}} />); });
    const why = host.querySelector<HTMLElement>("[data-bar-why]");
    expect(why?.textContent).toContain("refresh failed: trantor balances: Kimi 401 unauthorized");
    // 20 minutes old is past the refetch threshold but under the 30-minute dim: no fake "as of".
    expect(why?.textContent).not.toContain("as of");
    expect(host.querySelector("[data-chip]")?.textContent).toContain("DeepSeek");
  });
});
