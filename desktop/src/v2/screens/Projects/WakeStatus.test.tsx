// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WakeRowState } from "../../../features/genesis/wakeRow";
import { WAKE_NOTICE_MS, WakeLine, WakeNotice } from "./WakeStatus";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DELIVERED: WakeRowState = { phase: "outcome", kind: "sent", text: "kickoff sent" };
const NOOP = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const notice = () => host.querySelector<HTMLElement>('[aria-live="polite"]');
const show = (state: WakeRowState = DELIVERED, activeProject = "trantor", startedAt = 1, withLine = false) => act(async () => {
  root.render(<>
    <WakeNotice wakes={new Map([["rock-os", state]])} wakeStarts={new Map([["rock-os", startedAt]])} activeProject={activeProject} />
    {withLine && <WakeLine project="rock-os" state={state} startedAt={startedAt} hint={false}
      onRetry={NOOP} onDismiss={NOOP} onDismissHint={NOOP} />}
  </>);
});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("WakeNotice", () => {
  it("takes top-bar layout space and dismisses without dismissing the Workspace line", async () => {
    await show(DELIVERED, "trantor", 1, true);
    expect(notice()?.className).toContain("min-w-0");
    expect(notice()?.className).not.toContain("fixed");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the wake notice"]')?.click(); });
    expect(notice()).toBeNull();
    expect(host.textContent).toContain("First prompt delivered to the orchestrator.");
    expect(host.querySelector('button[aria-label="Dismiss wake status"]')).not.toBeNull();
  });

  it.each(["sent", "woken"] as const)("leaves a %s outcome after eight seconds while the Workspace line stays", async kind => {
    vi.useFakeTimers();
    const state: WakeRowState = { phase: "outcome", kind, text: kind };
    await show(state, "trantor", 1, true);
    await advance(WAKE_NOTICE_MS - 1);
    expect(notice()).not.toBeNull();
    await advance(1);
    expect(notice()).toBeNull();
    expect(host.querySelector('[aria-label="rock-os start status"]')).not.toBeNull();
  });

  it("keeps in-flight and error notices until their state changes or they are dismissed", async () => {
    vi.useFakeTimers();
    await show({ phase: "running" });
    await advance(WAKE_NOTICE_MS * 2);
    expect(notice()).not.toBeNull();
    await show({ phase: "outcome", kind: "error", text: "boom" });
    await advance(WAKE_NOTICE_MS * 2);
    expect(notice()).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the wake notice"]')?.click(); });
    expect(notice()).toBeNull();
  });

  it("stays hidden for the active project and appears after switching projects", async () => {
    await show(DELIVERED, "rock-os");
    expect(notice()).toBeNull();
    await show(DELIVERED, "trantor");
    expect(notice()).not.toBeNull();
  });

  it("dismisses only the current wake", async () => {
    await show();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the wake notice"]')?.click(); });
    await show({ phase: "outcome", kind: "error", text: "boom" });
    expect(notice()).toBeNull();
    await show(DELIVERED, "trantor", 2);
    expect(notice()).not.toBeNull();
  });
});
