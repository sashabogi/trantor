// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useSettingsData } from "./useSettingsData";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(clearMocks);

function Probe() { const data = useSettingsData(""); return <p>{data.me}</p>; }

it("resolves local identity before any project is pinned", async () => {
  const calls: string[] = [];
  mockIPC(command => {
    calls.push(command);
    if (command === "known_projects") return [];
    if (command === "identity_name") return "new-owner";
    throw new Error(`Unexpected command: ${command}`);
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("new-owner");
    expect(calls).toContain("identity_name");
    expect(calls).not.toContain("hub_for_project");
  } finally { act(() => root.unmount()); }
});

it("shows identity lookup errors instead of an endless loading label", async () => {
  mockIPC(command => {
    if (command === "known_projects") return [];
    throw new Error("identity key unavailable");
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toContain("Could not read identity:");
    expect(host.textContent).toContain("identity key unavailable");
  } finally { act(() => root.unmount()); }
});
