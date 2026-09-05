// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow, type OnboardingFlowDeps } from "./OnboardingFlow";
import { AUTONOMY_DEFAULTS, type AutonomyResolved } from "./onboardingState";
import type { OnboardingApi } from "./onboardingApi";
import type { ProviderAccountsApi, ProviderStatus } from "../settings/providers/providerStatus";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const providerRow = (state: ProviderStatus["state"]): ProviderStatus => ({
  provider: "codex", label: "Codex", kind: "windows", connect: "cli-login",
  binary: { name: "codex", installed: true, path: "/usr/bin/codex" },
  auth: { artifact: null, present: state === "connected", mode: null },
  state, reason: "", usage: null, actions: state === "connected" ? ["login", "recheck", "remove"] : ["recheck", "remove"],
});

const fakeProviderApi = (providers: ProviderStatus[]): ProviderAccountsApi => ({
  status: vi.fn(async () => ({ available: true as const, providers })),
  login: vi.fn(async () => {}),
  verifyKey: vi.fn(async () => providers[0]),
  saveKey: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
});

const fakeOnboardingApi = (): OnboardingApi => ({
  get: vi.fn(async () => ({ flowVersion: 1, closedAt: null, lastCompletedStep: null })),
  hasHubPin: vi.fn(async () => false),
  setStep: vi.fn(async (step: string) => ({ flowVersion: 1, closedAt: null, lastCompletedStep: step })),
  close: vi.fn(async () => ({ flowVersion: 1, closedAt: Date.now(), lastCompletedStep: null })),
  reopen: vi.fn(async () => ({ flowVersion: 1, closedAt: null, lastCompletedStep: null })),
});

type Scenario = {
  providers?: ProviderStatus[];
  hasHubPin?: boolean;
  autonomy?: AutonomyResolved;
  projects?: string[];
};

function depsFor({ providers = [], hasHubPin = false, autonomy = { ...AUTONOMY_DEFAULTS }, projects = [] }: Scenario) {
  const api = fakeOnboardingApi();
  const providerApi = fakeProviderApi(providers);
  api.hasHubPin = vi.fn(async () => hasHubPin);
  const deps: OnboardingFlowDeps = {
    api,
    providerApi,
    knownProjects: vi.fn(async () => projects),
    autonomyResolved: vi.fn(async () => autonomy),
    devRoot: vi.fn(async () => "/Users/test/development"),
  };
  return { deps, api, providerApi };
}

describe("OnboardingFlow", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const mount = async (deps: OnboardingFlowDeps, onClose = vi.fn()) => {
    await act(async () => {
      root.render(<OnboardingFlow me="sasha@mac" project="trantor" onClose={onClose} deps={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    return onClose;
  };

  it("shows only the steps that are not already satisfied, in order", async () => {
    const { deps } = depsFor({
      providers: [providerRow("connected")],   // satisfied — skipped
      hasHubPin: true,                          // satisfied — skipped
      autonomy: { ...AUTONOMY_DEFAULTS },        // unsatisfied — shown
      projects: [],                              // unsatisfied — shown
    });
    await mount(deps);
    expect(host.textContent).toContain("Autonomy");
    expect(host.textContent).toContain("1 / 2");
    expect(host.textContent).not.toContain("Connect a provider");
  });

  it("closes immediately, showing nothing, when every step is already satisfied", async () => {
    const { deps, api } = depsFor({
      providers: [providerRow("connected")],
      hasHubPin: true,
      autonomy: { ...AUTONOMY_DEFAULTS, commit: true },
      projects: ["trantor"],
    });
    const onClose = await mount(deps);
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".tr-card")).toBeNull();
  });

  it("Continue persists the completed step and advances to the next one", async () => {
    const { deps, api } = depsFor({
      providers: [providerRow("connected")],   // skip providers
      hasHubPin: false,                         // show identity
      autonomy: { ...AUTONOMY_DEFAULTS },        // show autonomy
      projects: ["trantor"],                    // skip project
    });
    const onClose = await mount(deps);
    expect(host.textContent).toContain("Identity and hub");

    const continueBtn = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Continue") || b.textContent?.includes("Done"));
    await act(async () => { continueBtn()?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });

    expect(api.setStep).toHaveBeenCalledWith("identity");
    expect(host.textContent).toContain("Autonomy");
    expect(api.close).not.toHaveBeenCalled();

    await act(async () => { continueBtn()?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });

    expect(api.setStep).toHaveBeenCalledWith("autonomy");
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gates Continue on the providers step until a provider is actually connected", async () => {
    const { deps } = depsFor({
      providers: [providerRow("not_logged_in")],
      hasHubPin: true,
      autonomy: { ...AUTONOMY_DEFAULTS, commit: true },
      projects: ["trantor"],
    });
    await mount(deps);
    expect(host.textContent).toContain("Connect a provider");
    const continueBtn = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Continue") || b.textContent?.includes("Done"));
    expect(continueBtn()?.hasAttribute("disabled")).toBe(true);
  });
});
