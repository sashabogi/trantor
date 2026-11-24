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
    act(() => root.render(<PlansBar report={report()} failure={null} machines={machines()} spinning={false} onRefresh={() => {}} onOpenUsage={onOpenUsage} />));
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
    act(() => root.render(<PlansBar report={null} failure="not enrolled" machines={null} spinning={false} onRefresh={() => {}} onOpenUsage={() => {}} />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("usage unavailable: not enrolled");
    expect(host.textContent).toContain("hub unreachable");
    expect(host.querySelector("[data-chip]")).toBeNull();
  });

  it("has a labelled refresh control", () => {
    const onRefresh = vi.fn();
    act(() => root.render(<PlansBar report={report()} failure={null} machines={null} spinning={false} onRefresh={onRefresh} onOpenUsage={() => {}} />));
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
});
