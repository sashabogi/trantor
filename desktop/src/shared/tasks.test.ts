import { afterEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "./api/client";
import { refreshTasks, subscribeTasks } from "./tasks";

afterEach(() => { vi.useRealTimers(); });

function clientWithTransport() {
  const calls: { method: string; path: string }[] = [];
  const client = new HubClient("http://hub", async ({ method, path }) => {
    calls.push({ method, path });
    return { status: 200, body: JSON.stringify({ tasks: [] }) };
  });
  return { client, calls };
}

describe("slim task reads", () => {
  it("tasks() requests the slim projection", async () => {
    const { client, calls } = clientWithTransport();
    await client.tasks("trantor");
    expect(calls[0]).toEqual({ method: "GET", path: "/tasks?project=trantor&fields=slim" });
  });

  it("an opened card reads /card only, never a cross-project /tasks", async () => {
    const { client, calls } = clientWithTransport();
    await client.card(42).catch(() => {});
    expect(calls).toEqual([{ method: "GET", path: "/card?id=42" }]);
  });

  it("two subscribers share one request per poll tick", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientWithTransport();
    const stopA = subscribeTasks(client, "trantor", () => {});
    const stopB = subscribeTasks(client, "trantor", () => {});
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls).toHaveLength(2);
    stopA(); stopB();
    await refreshTasks(client, "trantor");
    expect(calls).toHaveLength(3);
  });
});
