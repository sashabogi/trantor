// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsPane } from "./AccountsPane";
import { providerVerify, PROVIDER_STATES, type ProviderAccountsApi, type ProviderState, type ProviderStatus } from "./providerStatus";
import { stateLabel } from "./ProviderRow";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (state: ProviderState, index = 0): ProviderStatus => ({
  provider: state === "connected" ? "codex" : `provider-${index}`,
  label: state === "connected" ? "Codex" : `Provider ${index}`,
  kind: state === "connected" ? "windows" : "quota",
  connect: state === "connected" ? "cli-login" : "api-key",
  binary: { name: `cli-${index}`, installed: state !== "not_installed", path: state === "not_installed" ? null : `/usr/bin/cli-${index}` },
  auth: { artifact: `/account/auth-${index}.json`, present: state === "connected", mode: state === "connected" ? "chatgpt" : null },
  state,
  reason: `${state} reason`,
  usage: state === "connected" ? { provider: "codex", label: "Codex", kind: "subscription", ok: true, low: false, plan: "Pro" } : null,
  actions: state === "connected" ? ["login", "recheck", "remove"] : ["paste-key", "recheck", "remove"],
});

const apiFor = (providers: ProviderStatus[]) => ({
  status: vi.fn(async () => providers),
  login: vi.fn(async () => {}),
  verifyKey: vi.fn(async (provider: string) => providers.find(row => row.provider === provider) ?? providers[0]),
  saveKey: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}) satisfies ProviderAccountsApi;

describe("Settings Accounts pane", () => {
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
  });

  const mount = async (api: ProviderAccountsApi) => {
    await act(async () => {
      root.render(<AccountsPane project="drills" api={api} />);
      await Promise.resolve();
    });
  };

  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label));
  const click = async (el: Element | undefined | null) => {
    if (!el) throw new Error("button not found");
    await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  // SAFETY: React tracks value writes through the prototype setter; this is the exact browser
  // input boundary the component listens to, and `input` is selected from an <input> element.
  const typeInto = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("renders every provider state as a one-line row with its reason and honest usage", async () => {
    const providers = PROVIDER_STATES.map(row);
    await mount(apiFor(providers));

    for (const status of providers) {
      const rendered = host.querySelector(`[data-state="${status.state}"]`);
      expect(rendered).toBeTruthy();
      expect(rendered?.textContent).toContain(stateLabel(status.state));
      expect(rendered?.textContent).toContain(status.reason);
      expect(rendered?.querySelector(`[aria-label="Re-check ${status.label}"]`)).toBeTruthy();
      expect(rendered?.querySelector(`[aria-label="Remove ${status.label}"]`)).toBeTruthy();
    }
    expect(host.querySelector('[data-state="connected"]')?.textContent).toContain("plan");
  });

  it("expands install guidance without turning the compact row into a wall of text", async () => {
    const status = row("not_installed", 1);
    await mount(apiFor([status]));
    await click(host.querySelector(`[aria-label="Show ${status.label} account details"]`));
    expect(host.textContent).toContain(`brew install ${status.binary.name}`);
    expect(host.querySelector(`[aria-label="Copy install command for ${status.label}"]`)).toBeTruthy();
  });

  it("re-probes only after the provider login pane exits", async () => {
    const status = row("connected");
    const api = apiFor([status]);
    let finishLogin: (() => void) | undefined;
    api.login.mockImplementation(() => new Promise(resolve => { finishLogin = resolve; }));
    await mount(api);
    await click(button("Log in"));
    expect(api.login).toHaveBeenCalledWith("codex", "drills");
    expect(api.status).toHaveBeenCalledTimes(1);
    await act(async () => { finishLogin?.(); await Promise.resolve(); });
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("Paste key shows provider steps and verifies before saving", async () => {
    const status = { ...row("not_logged_in", 2), provider: "zai", label: "GLM" };
    const api = apiFor([status]);
    const order: string[] = [];
    api.verifyKey.mockImplementation(async () => { order.push("verify"); return status; });
    api.saveKey.mockImplementation(async () => { order.push("save"); });
    await mount(api);
    await click(button("Paste key"));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Get the key from Z.ai console");
    expect(dialog?.querySelectorAll("ol li")).toHaveLength(3);
    const input = dialog?.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error("key input missing");
    await typeInto(input, "candidate-key");
    await click(button("Verify and save"));
    expect(order).toEqual(["verify", "save"]);
    expect(api.verifyKey).toHaveBeenCalledWith("zai", "candidate-key");
    expect(api.saveKey).toHaveBeenCalledWith("zai", "candidate-key");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses the frozen pre-save provider_verify seam and decodes its status row", async () => {
    const status = { ...row("connected"), provider: "zai", label: "GLM" };
    const run = vi.fn(async () => JSON.stringify(status));

    await expect(providerVerify("zai", "candidate-key", run)).resolves.toEqual(status);
    expect(run).toHaveBeenCalledWith("provider_verify", { name: "zai", key: "candidate-key" });
  });

  it("Paste key refuses to save when the live verification fails", async () => {
    const status = { ...row("not_logged_in", 2), provider: "zai", label: "GLM" };
    const api = apiFor([status]);
    api.verifyKey.mockRejectedValue(new Error("provider rejected the key"));
    await mount(api);
    await click(button("Paste key"));
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error("key input missing");
    await typeInto(input, "bad-key");
    await click(button("Verify and save"));
    expect(api.saveKey).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Nothing was saved");
  });

  it("Remove requires confirmation before changing the system provider", async () => {
    const status = row("connected");
    const api = apiFor([status]);
    await mount(api);
    await click(host.querySelector(`[aria-label="Remove ${status.label}"]`));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("One login");
    expect(api.remove).not.toHaveBeenCalled();
    await click(button("Remove"));
    expect(api.remove).toHaveBeenCalledWith("codex");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
