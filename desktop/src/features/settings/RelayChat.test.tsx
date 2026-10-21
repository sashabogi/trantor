// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RelayChat } from "./RelayChat";

const api = { get: vi.fn<() => Promise<boolean>>(), set: vi.fn<(on: boolean) => Promise<boolean>>() };
// SAFETY: React reads this test-only flag from globalThis when act() flushes updates.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  api.get.mockReset();
  api.set.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("loads the durable switch and turns it off only after Rust confirms", async () => {
  api.get.mockResolvedValueOnce(true);
  api.set.mockResolvedValueOnce(false);
  await act(async () => { root.render(<RelayChat api={api} />); });
  const button = host.querySelector("button")!;
  expect(button.getAttribute("aria-checked")).toBe("true");
  await act(async () => { button.click(); });
  expect(api.set).toHaveBeenLastCalledWith(false);
  expect(button.getAttribute("aria-checked")).toBe("false");
});

it("keeps the saved state and shows a failed persistence attempt", async () => {
  api.get.mockResolvedValueOnce(true);
  api.set.mockRejectedValueOnce("Config is not writable");
  await act(async () => { root.render(<RelayChat api={api} />); });
  const button = host.querySelector("button")!;
  await act(async () => { button.click(); });
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Config is not writable");
  expect(button.disabled).toBe(false);
});
