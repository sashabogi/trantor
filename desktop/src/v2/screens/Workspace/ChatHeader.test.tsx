// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHeader, type ChatHeaderState } from "./ChatHeader";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const base: ChatHeaderState = {
  title: "Fix the login form", branch: "fix/login", model: "claude-opus-5-5",
  text: null, tone: "doing", handoff: null, onBack: null,
};
const mount = async (state = base, brand?: string) => {
  await act(async () => root.render(<ChatHeader state={state} brand={brand} />));
};

describe("ChatHeader", () => {
  it("orders the avatar, truncated title, branch and human model name in one header", async () => {
    await mount();
    const header = host.querySelector("header")!;
    expect(header.children[0].getAttribute("role")).toBe("img");
    const title = header.children[1].firstElementChild;
    expect(title?.textContent).toBe(base.title);
    expect(title?.getAttribute("title")).toBe(base.title);
    expect(title?.className).toContain("truncate");
    expect(header.children[2].textContent).toBe(base.branch);
    expect(header.children[2].querySelector("svg")).not.toBeNull();
    expect(header.children[2].querySelector("[title]")?.getAttribute("title")).toBe(base.branch);
    expect(header.children[3].textContent).toBe("Opus 5.5");
    expect(host.textContent).not.toContain("claude-opus-5-5");
    expect(host.querySelector('[data-testid="chat-status"]')).toBeNull();
  });

  it("hides unknown branches and models, trims names and uses New chat when empty", async () => {
    await mount({ ...base, title: "  Saved session name  ", branch: "", model: "" });
    expect(host.querySelector("header")?.textContent).toContain("Saved session name");
    expect(host.querySelector('[title="Saved session name"]')).not.toBeNull();
    expect(host.querySelector("[data-tone]")).toBeNull();
    await mount({ ...base, title: "   " });
    expect(host.querySelector('[title="New chat"]')).not.toBeNull();
  });

  it("places activity beneath the name and removes it when idle", async () => {
    await mount({ ...base, text: "working · reading files" });
    const status = host.querySelector('[data-testid="chat-status"]');
    expect(status?.previousElementSibling?.textContent).toBe(base.title);
    expect(status?.className).toContain("text-[var(--v2-muted)]");
    await mount();
    expect(host.querySelector('[data-testid="chat-status"]')).toBeNull();
  });

  it.each([
    ["claude", "Claude", "Claude Code"], ["MacBook-Pro:project", "Claude", "Claude Code"],
    ["codex-2", "Codex", "Codex"], ["kimi", "Kimi", "Kimi"], ["glm", "GLM (Z.ai)", "GLM (Z.ai)"],
  ])("resolves the %s harness with the existing vendor marks", async (identity, mark, label) => {
    await mount(base, identity);
    expect(host.querySelector("[data-brand]")?.getAttribute("data-brand")).toBe(mark);
    expect(host.querySelector("[data-brand] svg")).not.toBeNull();
    expect(host.querySelector('[role="img"]')?.getAttribute("title")).toBe(`Orchestrator · ${label}`);
    expect(host.querySelector('[role="img"]')?.textContent).not.toBe("OR");
  });

  it("falls back to the monogram for an unknown harness", async () => {
    await mount(base, "unknown-harness");
    expect(host.querySelector("[data-brand]")).toBeNull();
    expect(host.querySelector('[role="img"]')?.textContent).toBe("OR");
  });

  it("keeps confirm disabled with its reason while leaving Cancel usable", async () => {
    const confirm = vi.fn(), cancel = vi.fn();
    await mount({ ...base, handoff: { confirming: true, disabledReason: "A handoff is already running", onAsk: vi.fn(), onConfirm: confirm, onCancel: cancel } });
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map(b => b.textContent)).toEqual(["Confirm handoff", "Cancel"]);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].title).toBe("A handoff is already running");
    await act(async () => { buttons[0].click(); buttons[1].click(); });
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps workspace icons after session controls and their actions connected", async () => {
    const onSheet = vi.fn(), onGit = vi.fn(), onClose = vi.fn();
    const actions = { sheet: null, onSheet, changed: 3, sessionId: "session-1", project: "p", onGit, onClose };
    await act(async () => root.render(<ChatHeader state={base} actions={actions} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map(b => b.getAttribute("aria-label"))).toEqual(["New chat", "Sessions", "Git", "More", "Close chat"]);
    await act(async () => { buttons[1].click(); buttons[2].click(); buttons[4].click(); });
    expect(onSheet).toHaveBeenCalledWith("sessions");
    expect(onGit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => buttons[0].click());
    expect(host.querySelector('[role="menu"]')?.textContent).toContain("Hand off to a fresh session");
  });
});
