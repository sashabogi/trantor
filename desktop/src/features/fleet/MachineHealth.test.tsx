// @vitest-environment happy-dom
// #13920: the bottom bar's machine-health segment — fresh numbers, greyed "stale" past the hub's
// window, and nothing at all when no machine reports. Pure-row tests feed reports directly; the
// wiring test mounts the real strip with both transports mocked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient, type MachinesHealthReport } from "../../shared/api/client";
import { MachineHealthRows } from "./MachineHealth";
import { BalanceStrip } from "./BalanceStrip";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GiB = 2 ** 30;
const netcup = { machine: "netcup", cpuPct: 34, memUsed: 21 * GiB, memTotal: 62 * GiB, ts: Date.now() };

describe("MachineHealthRows — fresh, stale, absent", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });
  const render = async (report: MachinesHealthReport | null) =>
    act(async () => { root.render(<MachineHealthRows report={report} />); });

  it("renders the live numbers for a fresh machine, un-greyed", async () => {
    await render({ machines: [netcup], staleAfterMs: 90_000 });
    const row = host.querySelector('[data-machine="netcup"]');
    expect(row?.textContent).toBe("netcupCPU 34% · 21/62 GB");
    expect(row?.className).not.toContain("opacity-45");
  });

  it("greys a stale machine and says so instead of passing old numbers off as live", async () => {
    await render({ machines: [{ ...netcup, ts: Date.now() - 120_000 }], staleAfterMs: 90_000 });
    const row = host.querySelector('[data-machine="netcup"]');
    expect(row?.textContent).toContain("CPU 34% · 21/62 GB · stale");
    expect(row?.className).toContain("opacity-45");
    expect(row?.getAttribute("title")).toContain("unreachable");
  });

  it("renders nothing when no machine reports (null report or empty list)", async () => {
    await render({ machines: [], staleAfterMs: 90_000 });
    expect(host.textContent).toBe("");
    await render(null);
    expect(host.textContent).toBe("");
  });

  it("keeps an oversubscribed machine honest: load above the cores reads above 100%", async () => {
    await render({ machines: [{ ...netcup, cpuPct: 150 }], staleAfterMs: 90_000 });
    expect(host.textContent).toContain("CPU 150%");
  });
});

describe("BalanceStrip carries machine health in the footer", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mockIPC((command, args) => {
      if (command === "machine_id") return "MacBook-Test";
      // SAFETY: the strip and the health hook only ever invoke hub_request with a string path.
      const { path } = args as { path: string };
      if (path === "/machines/health") return { status: 200, body: JSON.stringify({ machines: [netcup], staleAfterMs: 90_000 }) };
      return { status: 200, body: JSON.stringify({ ts: Date.now(), entries: [] }) };
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });
  const mount = () => act(async () => { root.render(<BalanceStrip client={new HubClient("http://127.0.0.1:4477")} />); });

  it("shows the machine row inside the footer even with no balance chips", async () => {
    await mount();
    const row = host.querySelector("footer [data-machine='netcup']");
    expect(row?.textContent).toContain("CPU 34% · 21/62 GB");
  });

  it("renders no footer at all when neither balances nor machines report", async () => {
    mockIPC((command, args) => {
      if (command === "machine_id") return "MacBook-Test";
      // SAFETY: the strip and the health hook only ever invoke hub_request with a string path.
      const { path } = args as { path: string };
      if (path === "/machines/health") return { status: 200, body: JSON.stringify({ machines: [], staleAfterMs: 90_000 }) };
      return { status: 200, body: JSON.stringify({ ts: 0, entries: [] }) };
    });
    await mount();
    expect(host.querySelector("footer")).toBeNull();
  });
});
