// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ProjectsFolderRow } from "./GeneralPages";
import { CheckoutRecovery } from "../../ui/CheckoutRecovery";
import { takeSettingsSection } from "../../shell/settingsIntent";
import { PROJECT_FOLDERS_CHANGED } from "../../projectsFolder";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let source: "setting" | "default" | "TRANTOR_DEV_ROOT";
let selected: string | null;
let rejectSave: boolean;
const calls: [string, unknown][] = [];
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  source = "default"; selected = "/home/me/code"; rejectSave = false; calls.length = 0;
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "projects_root_get") return { path: "/home/me/development", source };
    if (cmd === "plugin:dialog|open") return selected;
    if (cmd === "projects_root_set") {
      if (rejectSave) throw "Choose an existing folder with an absolute path";
      // SAFETY: projects_root_set receives the nullable path from setProjectsRoot.
      const path = (args as { path: string | null }).path;
      return { path: path ?? "/home/me/development", source: path ? "setting" : "default" };
    }
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); takeSettingsSection(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function mount() { act(() => root.render(<ProjectsFolderRow />)); await flush(); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === text);
  expect(button).toBeDefined(); act(() => button?.click()); await flush();
}

it.each(["default", "setting", "TRANTOR_DEV_ROOT"] as const)("shows resolved path and %s source", async value => {
  source = value; await mount();
  expect(host.textContent).toContain(`/home/me/development · Source: ${value}`);
  if (value === "TRANTOR_DEV_ROOT") expect(host.textContent).toContain("takes precedence");
});

it("Choose opens the native folder picker, saves and immediately shows the new root", async () => {
  const changed = vi.fn(); window.addEventListener(PROJECT_FOLDERS_CHANGED, changed);
  try {
    await mount(); await click("Choose…");
    expect(calls).toContainEqual(["plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose your projects folder" } }]);
    expect(calls).toContainEqual(["projects_root_set", { path: "/home/me/code" }]);
    expect(host.textContent).toContain("/home/me/code · Source: setting");
    expect(changed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener(PROJECT_FOLDERS_CHANGED, changed); }
});

it("reset clears the saved setting without opening the picker", async () => {
  source = "setting"; await mount(); await click("Reset to default");
  expect(calls).toContainEqual(["projects_root_set", { path: null }]);
  expect(calls.some(([cmd]) => cmd === "plugin:dialog|open")).toBe(false);
  expect(host.textContent).toContain("Source: default");
});

it("cancel leaves the setting unchanged", async () => {
  selected = null; await mount(); await click("Choose…");
  expect(calls.some(([cmd]) => cmd === "projects_root_set")).toBe(false);
  expect(host.textContent).toContain("Source: default");
});

it("shows directory validation failures", async () => {
  rejectSave = true; await mount(); await click("Choose…");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("existing folder");
  expect(host.textContent).toContain("Source: default");
});

it("recovery saves a project override and links to General settings", async () => {
  const navigate = vi.fn();
  act(() => root.render(<CheckoutRecovery project="demo" onNavigate={navigate} />));
  await click("Choose the folder for demo");
  expect(calls).toContainEqual(["project_folder_set", { project: "demo", path: "/home/me/code" }]);
  expect(host.textContent).toContain("Folder saved");
  await click("Projects folder setting");
  expect(navigate).toHaveBeenCalledWith("settings");
  expect(takeSettingsSection()).toBe("general");
});
