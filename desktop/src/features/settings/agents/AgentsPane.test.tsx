// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPane } from "./AgentsPane";
import type { AgentSettingsApi, AgentSettingsStatus, AgentStatus } from "./agentSettings";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, installed: boolean, overrides: Partial<AgentStatus> = {}): AgentStatus => ({
  id,
  label: id === "codex" ? "Codex" : id === "glm" ? "GLM" : id,
  launch: id === "glm" ? "glm:zai-coding-plan" : id,
  cli: id === "glm" ? "opencode" : id,
  installed,
  enabled: true,
  isDefault: false,
  homepage: `https://example.test/${id}`,
  install: `install ${id}`,
  ...overrides,
});

const apiFor = (initial: AgentSettingsStatus) => {
  let state = initial;
  const api: AgentSettingsApi = {
    status: vi.fn(async () => state),
    setEnabled: vi.fn(async (id, enabled) => {
      state = {
        default: !enabled && state.default === id ? null : state.default,
        agents: state.agents.map(item => item.id === id
          ? { ...item, enabled, isDefault: enabled ? item.isDefault : false }
          : item),
      };
      return state;
    }),
    setDefault: vi.fn(async id => {
      state = { default: id, agents: state.agents.map(item => ({ ...item, isDefault: item.id === id })) };
      return state;
    }),
  };
  return api;
};

describe("Settings Agents pane", () => {
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

  const mount = async (api: AgentSettingsApi) => {
    await act(async () => { root.render(<AgentsPane api={api} />); await Promise.resolve(); });
  };

  const click = async (label: string, scope: ParentNode = host) => {
    const button = [...scope.querySelectorAll("button")].find(item => item.textContent?.includes(label));
    if (!button) throw new Error(`button not found: ${label}`);
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
  };

  it("mirrors Orca's Default, Installed, and Available hierarchy", async () => {
    await mount(apiFor({ default: "codex", agents: [agent("codex", true, { isDefault: true }), agent("glm", false)] }));

    expect(host.textContent).toContain("Default Agent");
    expect(host.textContent).toContain("Installed1 detected");
    expect(host.textContent).toContain("Available to install1 agents");
    expect(host.querySelector('[data-agent="codex"]')?.textContent).toContain("trantor up codex");
    expect(host.querySelector('[data-agent="glm"]')?.textContent).toContain("trantor up glm:zai-coding-plan");
  });

  it("sets Auto and an installed agent as the persisted default", async () => {
    const api = apiFor({ default: null, agents: [agent("codex", true)] });
    await mount(api);

    await click("Codex", host.querySelector("section") ?? host);
    expect(api.setDefault).toHaveBeenCalledWith("codex");
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent?.trim()).toBe("Codex");
    await click("Auto");
    expect(api.setDefault).toHaveBeenCalledWith(null);
  });

  it("keeps a saved default visible when its CLI is temporarily undetected", async () => {
    await mount(apiFor({ default: "codex", agents: [agent("codex", false, { isDefault: true })] }));

    const selected = host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(selected?.textContent).toContain("Codex");
  });

  it("persists Enabled and Disabled and clears a disabled default", async () => {
    const api = apiFor({ default: "codex", agents: [agent("codex", true, { isDefault: true })] });
    await mount(api);
    const row = host.querySelector('[data-agent="codex"]');
    if (!row) throw new Error("Codex row missing");

    await click("Disabled", row);
    expect(api.setEnabled).toHaveBeenCalledWith("codex", false);
    expect(host.textContent).not.toContain("CodexDefault");
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent?.trim()).toBe("Auto");
  });

  it("expands an installed agent to its command details", async () => {
    await mount(apiFor({ default: null, agents: [agent("codex", true)] }));
    const expand = host.querySelector('button[aria-label="Expand Codex"]');
    if (!expand) throw new Error("expand button missing");
    await act(async () => { expand.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.querySelector('[data-agent="codex"]')?.textContent).toContain("Launch command");
  });
});
