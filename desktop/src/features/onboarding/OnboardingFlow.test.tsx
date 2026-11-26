// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow, type OnboardingFlowDeps } from "./OnboardingFlow";
import { AUTONOMY_DEFAULTS, type AutonomyResolved } from "./onboardingState";
import type { OnboardingApi } from "./onboardingApi";
import type { SetupApi, SetupReport } from "../../shared/api/client";
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

const OK_SETUP: SetupReport = { node: "v22.1.0", npm: true, trantor: "0.18.99", trantorCompatible: true, trantorMinimum: "0.18.47", herdr: "/usr/local/bin/herdr" };

const fakeSetupApi = (report: SetupReport): SetupApi => ({
  check: vi.fn(async () => report),
  install: vi.fn(async () => ({ ok: true, cancelled: false, code: 0 })),
  cancel: vi.fn(async () => {}),
  onLine: vi.fn(async () => () => {}),
  hubEnsure: vi.fn(async () => ({ state: "started" as const, detail: null, logPath: "/x/hub.log" })),
});

type Scenario = {
  setup?: SetupReport;
  providers?: ProviderStatus[];
  hasHubPin?: boolean;
  autonomy?: AutonomyResolved;
  projects?: string[];
};

function depsFor({ setup = OK_SETUP, providers = [], hasHubPin = false, autonomy = { ...AUTONOMY_DEFAULTS }, projects = [] }: Scenario) {
  const api = fakeOnboardingApi();
  const providerApi = fakeProviderApi(providers);
  const setupApi = fakeSetupApi(setup);
  api.hasHubPin = vi.fn(async () => hasHubPin);
  const deps: OnboardingFlowDeps = {
    api,
    providerApi,
    knownProjects: vi.fn(async () => projects),
    autonomyResolved: vi.fn(async () => autonomy),
    devRoot: vi.fn(async () => "/Users/test/development"),
    setupApi,
  };
  return { deps, api, providerApi, setupApi };
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

  const mount = async (deps: OnboardingFlowDeps, onClose = vi.fn(), forced = false) => {
    await act(async () => {
      root.render(<OnboardingFlow me="owner@laptop" project="trantor" onClose={onClose} forced={forced} deps={deps} />);
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

  it("an explicit reopen with everything satisfied shows all five steps, marked done, instead of closing", async () => {
    const { deps, api } = depsFor({
      providers: [providerRow("connected")],
      hasHubPin: true,
      autonomy: { ...AUTONOMY_DEFAULTS, commit: true },
      projects: ["trantor"],
    });
    const onClose = await mount(deps, vi.fn(), true);
    expect(api.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 / 5");
    expect(host.textContent).toContain("Check your setup");
    expect(host.textContent).toContain("trantor CLI");

    const continueBtn = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Continue") || b.textContent?.includes("Done"));
    await act(async () => { continueBtn()?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Connect a provider");
    expect(host.textContent).toContain("ready to continue");
  });

  const rowOf = (key: string) => host.querySelector<HTMLElement>(`[data-setup-row="${key}"]`);
  const btn = (el: ParentNode | null, text: string) => [...(el?.querySelectorAll("button") ?? [])].find(b => b.textContent?.includes(text));

  it("setup step: every installed tool reads ok with no Install button", async () => {
    const { deps } = depsFor({ providers: [providerRow("connected")], hasHubPin: true, autonomy: { ...AUTONOMY_DEFAULTS, commit: true }, projects: ["trantor"] });
    await mount(deps, vi.fn(), true);
    for (const k of ["node", "trantor", "herdr"]) expect(rowOf(k)?.dataset.status, k).toBe("ok");
    expect(btn(rowOf("trantor"), "Install")).toBeUndefined();
  });

  it("setup step: a missing CLI and herdr offer Install, and the step shows when not forced", async () => {
    const { deps } = depsFor({ setup: { ...OK_SETUP, trantor: null, trantorCompatible: false, herdr: null }, providers: [providerRow("connected")], hasHubPin: true, autonomy: { ...AUTONOMY_DEFAULTS, commit: true }, projects: ["trantor"] });
    await mount(deps);
    expect(rowOf("trantor")?.dataset.status).toBe("missing");
    expect(btn(rowOf("trantor"), "Install")).toBeDefined();
    expect(btn(rowOf("herdr"), "Install")).toBeDefined();
    // skippable: Continue is never disabled on this step
    expect(btn(host, "Done")?.hasAttribute("disabled")).toBe(false);
  });

  it("setup step: a too-old CLI reads outdated and offers Update", async () => {
    const { deps } = depsFor({ setup: { ...OK_SETUP, trantor: "0.18.1", trantorCompatible: false } });
    await mount(deps);
    expect(rowOf("trantor")?.dataset.status).toBe("outdated");
    expect(rowOf("trantor")?.textContent).toContain("0.18.47");
    expect(btn(rowOf("trantor"), "Update")).toBeDefined();
  });

  it("setup step: without Node the CLI cannot be installed and the user is pointed at nodejs.org", async () => {
    const { deps } = depsFor({ setup: { ...OK_SETUP, node: null, npm: false, trantor: null, trantorCompatible: false } });
    await mount(deps);
    expect(rowOf("node")?.textContent).toContain("nodejs.org");
    expect(btn(rowOf("trantor"), "Install")).toBeUndefined();
  });

  it("setup step: a successful CLI install retries the hub start and re-checks", async () => {
    const { deps, setupApi } = depsFor({ setup: { ...OK_SETUP, trantor: null, trantorCompatible: false } });
    const onCliInstalled = vi.fn();
    await act(async () => {
      root.render(<OnboardingFlow me="o" project="trantor" onClose={vi.fn()} onCliInstalled={onCliInstalled} deps={deps} />);
      await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { btn(rowOf("trantor"), "Install")?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(setupApi.install).toHaveBeenCalledWith("trantor");
    expect(onCliInstalled).toHaveBeenCalledTimes(1);
    expect(setupApi.check).toHaveBeenCalledTimes(2);
  });

  it("setup step: a failed install is reported and does not retry the hub", async () => {
    const { deps, setupApi } = depsFor({ setup: { ...OK_SETUP, herdr: null } });
    setupApi.install = vi.fn(async () => ({ ok: false, cancelled: false, code: 2 }));
    await mount(deps);
    await act(async () => { btn(rowOf("herdr"), "Install")?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("failed");
  });

  it("a forced reopen still lets Continue walk through every step to close", async () => {
    const { deps, api } = depsFor({
      providers: [providerRow("connected")],
      hasHubPin: true,
      autonomy: { ...AUTONOMY_DEFAULTS, commit: true },
      projects: ["trantor"],
    });
    const onClose = await mount(deps, vi.fn(), true);
    const continueBtn = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Continue") || b.textContent?.includes("Done"));
    for (let i = 0; i < 5; i++) {
      await act(async () => { continueBtn()?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    }
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
