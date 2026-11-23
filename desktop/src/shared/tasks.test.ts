import { afterEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "./api/client";
import { refreshTasks, subscribeTasks } from "./tasks";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("slim task reads", () => {
  it("tasks() requests the slim projection", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify({ tasks: [] }) });
    await new HubClient("http://hub").tasks("trantor");
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ path: "/tasks?project=trantor&fields=slim" });
  });

  it("full card hydration uses card=<id> on a slim request", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify({ tasks: [] }) });
    await new HubClient("http://hub").cards([42]);
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ path: "/tasks?fields=slim&card=42" });
  });

  it("two subscribers share one request per poll tick", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify({ tasks: [] }) });
    const client = new HubClient("http://hub");
    const stopA = subscribeTasks(client, "trantor", () => {});
    const stopB = subscribeTasks(client, "trantor", () => {});
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    stopA(); stopB();
    await refreshTasks(client, "trantor");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
