// @vitest-environment happy-dom
import { EmptyProjects } from "../../../features/settings/EmptyProjects";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { StartCard } from "./StartCard";
import { AllProjects } from "../../shell/ClassicLenses";
import { HubPage } from "../Settings/SystemPages";
import { TopBar } from "../../shell/TopBar";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mockIPC(command => command === "known_projects" ? [] : "");
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });
it.each(["dashboard", "projects", "hub", "switcher", "classic"])("offers project creation from the empty %s", async surface => {
  const start = vi.fn();
  await act(async () => root.render(
    surface === "classic" ? <EmptyProjects onStart={start} /> :
    surface === "dashboard" ? <StartCard onStart={start} /> :
    surface === "projects" ? <AllProjects projects={[]} live={[]} onNavigate={vi.fn()} onStartProject={start} /> :
    surface === "hub" ? <HubPage onStartProject={start} /> :
    <TopBar projects={[]} project="" onProject={vi.fn()} mode="orchestrator" onMode={vi.fn()} onSearch={vi.fn()} needsYou={0} me="" onNavigate={vi.fn()} onStartProject={start} onBackToClassic={vi.fn()} />
  ));
  if (surface === "switcher") act(() => host.querySelector<HTMLButtonElement>('button[title="Switch project"]')!.click());
  expect(document.body.textContent).toContain("No projects yet.");
  if (surface !== "hub") expect(document.body.textContent).not.toContain("trantor hub set");
  const button = [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Start a project"));
  act(() => button!.click());
  expect(start).toHaveBeenCalledOnce();
});
