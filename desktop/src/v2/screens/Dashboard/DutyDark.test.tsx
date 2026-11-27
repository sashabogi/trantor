// @vitest-environment happy-dom
// #14492: the Dashboard warns while the duty seat is dark, says how long, and hides when it is
// back — a state, not an event; Start brings it back without leaving the screen.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type DutyHealth, type HubHealth } from "../../../shared/api/client";
import { downFor, DutyDarkNote, useDutyDark } from "./DutyDark";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dark = (over: Partial<DutyHealth> = {}): DutyHealth => ({
  configured: true, online: false, lastSeenMs: 1_000, darkSinceMs: 23 * 60_000, queuedEscalations: 0, ...over,
});
const ONLINE: HubHealth = { ok: true, authMode: "key", peers: 1, messages: 0, streams: 0, duty: { ...dark(), online: true } };
const DARK: HubHealth = { ...ONLINE, duty: dark() };
const SILENT: HubHealth = { ...ONLINE, duty: { ...dark(), configured: false } };

let health: HubHealth = DARK;
const dutyCalls: string[] = [];
const client = new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify(health) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  health = DARK;
  dutyCalls.length = 0;
  mockIPC(command => {
    if (command === "duty_start") { dutyCalls.push(command); return "duty is up"; }
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  clearMocks();
  vi.useRealTimers();
});

const mount = async () => {
  await act(async () => { root.render(<DutyDarkNote client={client} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });

describe("downFor", () => {
  it("reads as duration words, from under a minute to hours", () => {
    expect(downFor(12_000)).toBe("under a minute");
    expect(downFor(60_000)).toBe("1 minute");
    expect(downFor(23 * 60_000)).toBe("23 minutes");
    expect(downFor(65 * 60_000)).toBe("1 hour 5 minutes");
    expect(downFor(2 * 3_600_000)).toBe("2 hours");
  });
});

describe("DutyDarkNote", () => {
  it("shows one calm line with the duration while the seat is dark", async () => {
    await mount();
    const note = host.querySelector('[data-note="duty-dark"]');
    expect(note?.textContent).toContain("Duty seat is down · 23 minutes");
    expect(note?.textContent).not.toContain("escalation");
    expect(host.querySelector('[data-note="duty-dark"] button')?.textContent).toContain("Start duty");
  });

  it("is a state: the warning leaves when the hub says the seat is back", async () => {
    await mount();
    expect(host.querySelector('[data-note="duty-dark"]')).not.toBeNull();
    health = ONLINE;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(host.querySelector('[data-note="duty-dark"]')).toBeNull();
  });

  it("stays silent when no duty seat is configured — nothing to mourn", async () => {
    health = SILENT;
    await mount();
    expect(host.querySelector('[data-note="duty-dark"]')).toBeNull();
    expect(host.textContent).not.toContain("Duty seat");
  });

  it("starts the duty seat from the note and the warning goes once the hub sees it up", async () => {
    await mount();
    await click(host.querySelector('[data-note="duty-dark"] button'));
    expect(dutyCalls).toEqual(["duty_start"]);
    health = ONLINE;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(host.querySelector('[data-note="duty-dark"]')).toBeNull();
  });

  it("a failed start keeps the warning and reports why, in one line", async () => {
    await mount();
    mockIPC(command => {
      if (command === "duty_start") { dutyCalls.push(command); throw new Error("trantor CLI not found"); }
      return null;
    });
    await click(host.querySelector('[data-note="duty-dark"] button'));
    expect(dutyCalls).toEqual(["duty_start"]);
    expect(host.querySelector('[data-note="duty-dark"]')?.textContent).toContain("start failed: trantor CLI not found");
    expect(host.querySelector('[data-note="duty-dark"]')?.textContent).toContain("Duty seat is down · 23 minutes");
  });
});

describe("useDutyDark", () => {
  it("keeps the last reading while the hub is unreachable instead of flashing the note away", async () => {
    health = DARK;
    let broken = false;
    const flaky = new HubClient("http://hub.test", async () => {
      if (broken) throw new Error("hub down");
      return { status: 200, body: JSON.stringify(health) };
    });
    await act(async () => { root.render(<Probe client={flaky} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain("dark");
    broken = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(host.textContent).toContain("dark");
  });
});

/** Renders the hook's reading, so its state machine can be asserted without the note's markup. */
function Probe({ client }: { client: HubClient }) {
  const { duty, busy, error } = useDutyDark(client);
  return <div>{error ? `error: ${error}` : duty?.online === false ? "dark" : duty ? "up" : "no reading"}{busy ? " · busy" : ""}</div>;
}
