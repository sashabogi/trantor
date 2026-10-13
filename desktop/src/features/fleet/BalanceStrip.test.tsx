// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient } from "../../shared/api/client";
import { BalanceStrip } from "./BalanceStrip";

const transport = vi.fn<() => Promise<{ status: number; body: string }>>();
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = () => ({ status: 200, body: JSON.stringify({ ts: Date.now(), entries: [
  { provider: "deepseek", label: "DeepSeek", ok: true, remaining: 12.34 },
] }) });

describe("BalanceStrip hub failures", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    transport.mockReset();
    mockIPC((command, args) => {
      expect(command).toBe("hub_request");
      expect(args).toMatchObject({ base: "http://127.0.0.1:4477", method: "GET", path: "/balances" });
      return transport();
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });
  const mount = () => act(async () => { root.render(<BalanceStrip client={new HubClient("http://127.0.0.1:4477")} />); });
  const refresh = () => act(async () => { window.dispatchEvent(new Event("focus")); });

  it("shows a dim visible failure on the first 401 and recovers on refresh", async () => {
    transport.mockResolvedValueOnce({ status: 401, body: '{"error":"unknown identity"}' });
    await mount();
    expect(host.querySelector("footer")).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("usage unavailable: not enrolled");
    expect(host.querySelector('[role="status"]')?.parentElement?.className).toContain("opacity-45");
    transport.mockResolvedValueOnce(snapshot());
    await refresh();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toContain("$12.3");
  });

  it("retains prior provider values alongside the failure reason", async () => {
    transport.mockResolvedValueOnce(snapshot());
    await mount();
    expect(host.textContent).toContain("$12.3");
    transport.mockResolvedValueOnce({ status: 401, body: '{"error":"unknown identity"}' });
    await refresh();
    expect(host.textContent).toContain("$12.3");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("usage unavailable:");
  });

  it("shows transport or enrollment refusal even with no previous providers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.mockRejectedValueOnce("Local hub enrollment refused: tofu enrollment refused");
    await mount();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("usage unavailable:");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("tofu enrollment refused");
  });

  it("shows a refusal after an empty successful snapshot", async () => {
    transport.mockResolvedValueOnce({ status: 200, body: '{"entries":[],"ts":0}' });
    await mount();
    transport.mockResolvedValueOnce({ status: 403, body: '{"error":"forbidden"}' });
    await refresh();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("403");
    expect(host.querySelector("footer")).not.toBeNull();
  });
});
