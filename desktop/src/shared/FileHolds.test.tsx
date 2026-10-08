// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileHoldsSection } from "./FileHolds";
import { HubClient, type FileHold, type HubEvent } from "./api/client";
import { notificationFor } from "./notify";

// SAFETY: React's test scheduler reads this global flag; it is absent from DOM's type declarations.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
const hold: FileHold = { id: 42, project: "alpha", file: "src/a.ts", session: "later", other: "first", status: "pending", ts: 1000 };
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

async function mount(fail = false) {
  const client = new HubClient("http://test");
  let rows = [hold];
  let emit: (event: HubEvent) => void = () => {};
  vi.spyOn(client, "holds").mockImplementation(async () => ({ holds: rows }));
  const off = vi.fn();
  vi.spyOn(client, "streamEvents").mockImplementation(fn => { emit = fn; return off; });
  const decide = vi.spyOn(client, "decideHold").mockImplementation(async () => {
    if (fail) throw new Error("offline");
    rows = [];
    emit({ type: "hold.decided", ts: 1100 });
    return { ok: true };
  });
  await act(async () => root.render(<FileHoldsSection client={client} />));
  return { decide, off };
}

it.each(["go", "nogo"] as const)("shows conflicting sessions and submits %s, then removes the decided row", async status => {
  const { decide } = await mount();
  expect(host.textContent).toContain("later is held by first");
  expect(host.textContent).toContain("src/a.ts");
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === (status === "go" ? "Go" : "No-go"));
  await act(async () => button?.click());
  expect(decide).toHaveBeenCalledWith(hold, status);
  expect(host.textContent).toBe("");
});

it("keeps the row and explains a failed decision", async () => {
  await mount(true);
  await act(async () => host.querySelector("button")?.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  expect(host.textContent).toContain("src/a.ts");
});

it("notifies on the hold opening, without repeating on decisions or expiry", () => {
  expect(notificationFor({ type: "hold.opened", ts: 1000, project: "alpha", file: "src/a.ts" }, "operator")?.body).toContain("choose Go or No-go on Home");
  expect(notificationFor({ type: "hold.decided", ts: 1001 }, "operator")).toBeNull();
  expect(notificationFor({ type: "hold.expired", ts: 1002 }, "operator")).toBeNull();
});
