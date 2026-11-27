// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { HubClient, type Card } from "../../../shared/api/client";
import { cardOf, usePeerList } from "./useWorkspaceData";
import type { SeatView } from "./seatModel";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
function Probe({ client }: { client: HubClient }) {
  const { peers, error, refresh } = usePeerList(client);
  return <><p>{error ?? (peers === null ? "Reading seats" : `${peers.length} seats`)}</p><button onClick={refresh}>Refresh</button></>;
}
it("clears a failed peer read when a later refresh succeeds", async () => {
  let offline = true;
  const client = new HubClient("http://hub.test", async () => {
    if (offline) throw new Error("connection refused");
    return { status: 200, body: JSON.stringify({ peers: [] }) };
  });
  const stream = vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe client={client} />));
    expect(host.querySelector("p")?.textContent).toContain("Can't reach the hub");
    offline = false;
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("p")?.textContent).toBe("0 seats");
  } finally { act(() => root.unmount()); stream.mockRestore(); }
});

const seatOf = (session: string, agent: string): SeatView => ({
  key: session, label: agent, agent, brand: "test", session, presence: "working", words: "working", isOrchestrator: false,
  target: { key: session, label: agent, agent, brand: "test", session, online: true, isOrchestrator: false },
});

describe("cardOf (#14514)", () => {
  const now = Date.now();
  const orch = seatOf("MacBook-Pro:trantor", "MacBook-Pro:Ember");
  const day = 86_400_000;
  // The hub serves tasks oldest-first (ORDER BY id ASC); the fixtures mirror that order.
  it("shows the card the seat touched last, never its oldest open one", () => {
    const stale: Card = { id: 9743, project: "trantor", title: "Spike: run fast-jev-compaction fully local", status: "testing", assignee: "MacBook-Pro:trantor", updated: now - 60 * day };
    const current: Card = { id: 14516, project: "trantor", title: "The browser contract, wave 2", status: "doing", assignee: "MacBook-Pro:trantor", updated: now - 5 * 60_000 };
    expect(cardOf([stale, current], orch)).toBe(current);
  });
  it("an old done or todo card never shows, even as the only card assigned to the seat", () => {
    const done: Card = { id: 9743, project: "trantor", title: "Old spike", status: "done", assignee: "MacBook-Pro:trantor", updated: now };
    const todo: Card = { id: 9800, project: "trantor", title: "Queued", status: "todo", assignee: "MacBook-Pro:trantor" };
    expect(cardOf([done, todo], orch)).toBeUndefined();
  });
  it("nothing shows when the only open cards belong to another seat", () => {
    const other: Card = { id: 13970, project: "trantor", title: "Restore at login", status: "doing", assignee: "codex-8:trantor", updated: now };
    expect(cardOf([other], orch)).toBeUndefined();
  });
  it("falls back to a card assigned by agent name when none is assigned by session", () => {
    const assignedToAgent: Card = { id: 13970, project: "trantor", title: "Restore at login", status: "doing", assignee: "codex-8", updated: now };
    expect(cardOf([assignedToAgent], seatOf("codex-8:trantor", "codex-8"))).toBe(assignedToAgent);
  });
});
