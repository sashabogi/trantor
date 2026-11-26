// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { expect, it } from "vitest";
import { Avatar } from "./Avatar";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
it("updates mounted avatars when the shared machine identity arrives", async () => {
  let resolveId: (id: string) => void = () => {};
  const identity = new Promise<string>(resolve => { resolveId = resolve; });
  let calls = 0;
  mockIPC(command => { if (command === "machine_id") { calls++; return identity; } return ""; });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><Avatar name="studio-7:demo" /><Avatar name="MacBook-Other:demo" /></>));
    expect(host.querySelector('[aria-label="studio-7"]')).not.toBeNull();
    await act(async () => resolveId("studio-7"));
    expect(host.querySelector('[aria-label="orchestrator"] [data-brand="Claude"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="MacBook-Other"] [data-brand]')).toBeNull();
    expect(calls).toBe(1);
  } finally { act(() => root.unmount()); clearMocks(); }
});
