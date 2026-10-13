// @vitest-environment happy-dom
// #11640: the Interrupted strip's Resume click is never silent. Per-project guard, the running
// line, the error text with Resume enabled again, and the row leaving on success. The shell's
// project_wake call is a fake behind the same guard and outcome classifier the shell uses.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InterruptedStrip, interruptedError } from "./InterruptedStrip";
import { guardedWake } from "./wakeGuard";
import { classifyWakeOutcome, type WakeRowState } from "../features/genesis/wakeRow";
import type { RestorableSession } from "../features/workspace/herdr";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (project: string): RestorableSession => ({ project, sessionId: `${project}-s1` });

type Pending = { resolve: (line: string) => void; reject: (e: Error) => void };

/** The shell's wake path in miniature: guard, running state, classified outcome, drop on success. */
function Harness({ wakes }: { wakes: Map<string, Pending> }) {
  const [rows, setRows] = useState([row("builtbetter"), row("crebral-scrape-monitor")]);
  const [states, setStates] = useState<Map<string, WakeRowState>>(new Map());
  const [inflight] = useState(() => new Set<string>());
  const set = (p: string, s: WakeRowState) => setStates(prev => new Map(prev).set(p, s));
  const wake = (p: string) => void guardedWake(inflight, p, async () => {
    set(p, { phase: "running" });
    try {
      const line = await new Promise<string>((resolve, reject) => { wakes.set(p, { resolve, reject }); });
      set(p, classifyWakeOutcome(line, null));
      setRows(cur => cur.filter(r => r.project !== p));
    } catch (e) {
      set(p, classifyWakeOutcome(null, e instanceof Error ? e.message : String(e)));
    }
  });
  return <InterruptedStrip rows={rows} wakeStates={states} onResume={wake} onDismiss={() => {}} />;
}

let host: HTMLDivElement;
let root: Root;
let wakes: Map<string, Pending>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  wakes = new Map();
  act(() => root.render(<Harness wakes={wakes} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// SAFETY: every test renders both rows, so the lookup always finds the one <button> without a
// title (Resume); the dismiss button carries a title and is excluded by the selector.
const resumeButton = (project: string) =>
  [...host.querySelectorAll("div.flex.items-center")]
    .find(el => el.textContent?.includes(project))
    ?.querySelector("button:not([title])") as HTMLButtonElement;
const click = (b: HTMLButtonElement) => act(() => { b.click(); });
const settle = async (fn: () => void) => { await act(async () => { fn(); await Promise.resolve(); }); };

describe("the Interrupted strip (#11640)", () => {
  it("one project's running wake never swallows another project's click", () => {
    click(resumeButton("builtbetter"));
    expect(resumeButton("builtbetter").textContent).toBe("Resuming…");
    expect(resumeButton("builtbetter").disabled).toBe(true);
    expect(resumeButton("crebral-scrape-monitor").disabled).toBe(false);
    click(resumeButton("crebral-scrape-monitor"));
    expect([...wakes.keys()].sort()).toEqual(["builtbetter", "crebral-scrape-monitor"]);
  });

  it("a second click on the same project is ignored, visibly: the button stays Resuming…", () => {
    click(resumeButton("builtbetter"));
    click(resumeButton("builtbetter"));
    expect(wakes.size).toBe(1);
    expect(resumeButton("builtbetter").textContent).toBe("Resuming…");
    expect(resumeButton("builtbetter").disabled).toBe(true);
  });

  it("a failed wake shows its error with the full text in the title and Resume enabled again", async () => {
    click(resumeButton("builtbetter"));
    await settle(() => wakes.get("builtbetter")?.reject(new Error("herdr pane list failed: connection refused")));
    const btn = resumeButton("builtbetter");
    expect(btn.textContent).toBe("Resume");
    expect(btn.disabled).toBe(false);
    const line = host.querySelector('[title="herdr pane list failed: connection refused"]');
    expect(line?.textContent).toBe("herdr pane list failed: connection refused");
    expect(host.textContent).toContain("builtbetter");
  });

  it("a retry after a failure runs again and a success drops the row", async () => {
    click(resumeButton("builtbetter"));
    await settle(() => wakes.get("builtbetter")?.reject(new Error("boom")));
    click(resumeButton("builtbetter"));
    expect(resumeButton("builtbetter").textContent).toBe("Resuming…");
    await settle(() => wakes.get("builtbetter")?.resolve("project awake in pane w1:p1 · kickoff running in the background"));
    expect(host.textContent).not.toContain("builtbetter");
    expect(host.textContent).toContain("crebral-scrape-monitor");
  });
});

describe("interruptedError", () => {
  it("shows failures, not successes, and keeps the short line to one bounded line", () => {
    expect(interruptedError(undefined)).toBeNull();
    expect(interruptedError({ phase: "running" })).toBeNull();
    expect(interruptedError({ phase: "outcome", kind: "woken", text: "project awake" })).toBeNull();
    const long = `trantor open failed: ${"x".repeat(200)}\nsecond line`;
    const err = interruptedError({ phase: "outcome", kind: "error", text: long });
    expect(err?.full).toBe(long);
    expect(err?.short.length).toBeLessThanOrEqual(72);
    expect(err?.short.endsWith("…")).toBe(true);
    expect(err?.short).not.toContain("\n");
  });
});
