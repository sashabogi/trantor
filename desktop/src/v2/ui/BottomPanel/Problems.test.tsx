// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupProblems, Problems, runSummary, type ProblemCheck, type ProblemRun } from "./Problems";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHECKS: ProblemCheck[] = [
  { id: "typescript:desktop", label: "TypeScript (desktop)", kind: "typescript", directory: "desktop" },
  { id: "rust:src-tauri", label: "Rust (src-tauri)", kind: "rust", directory: "src-tauri" },
];
const ITEMS: ProblemRun["items"] = [
  { path: "desktop/src/a.ts", line: 14, column: 9, severity: "error", code: "TS2322", message: "Wrong type" },
  { path: "desktop/src/a.ts", line: 20, column: 1, severity: "warning", code: "TS1000", message: "Check this" },
  { path: "desktop/src/b.ts", line: 2, column: 4, severity: "error", code: "TS2304", message: "Missing name" },
];
const RESULT: ProblemRun = { items: ITEMS, exitCode: 1, durationMs: 41_000, raw: [], timedOut: false };

let host: HTMLDivElement;
let root: Root;
let checks: ProblemCheck[];
let result: ProblemRun;
let runs: { project: string; seat: string | null; id: string }[];
let runGate: Promise<void> | null;
let onOpen: ReturnType<typeof vi.fn>;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const runButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Run problem check"]');

async function mount(seat: string | null = null) {
  await act(async () => { root.render(<Problems project="trantor" seat={seat} onOpen={onOpen} />); });
  await flush();
}

async function run() {
  await act(async () => { runButton()?.click(); });
  await flush();
}

async function choose(value: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Problem check"]');
  await act(async () => {
    if (!select) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 2, 14, 2));
  checks = CHECKS;
  result = RESULT;
  runs = [];
  runGate = null;
  onOpen = vi.fn();
  mockIPC((command, args) => {
    if (command === "problems_checks") return JSON.stringify(checks);
    if (command === "problems_run") {
      // SAFETY: mockIPC types args as unknown; problems_run takes these three named arguments.
      const named = (args ?? {}) as { project: string; seat: string | null; id: string };
      runs.push(named);
      return (runGate ?? Promise.resolve()).then(() => JSON.stringify(result));
    }
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

describe("Problems", () => {
  it("discovers checks without running one and exposes the running state", async () => {
    let release = () => {};
    runGate = new Promise<void>(resolve => { release = resolve; });
    await mount("kimi-9");
    expect(runs).toEqual([]);
    expect([...host.querySelectorAll("option")].map(option => option.textContent)).toEqual([
      "TypeScript (desktop)", "Rust (src-tauri)",
    ]);
    await act(async () => { runButton()?.click(); });
    expect(runButton()?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Checking");
    expect(runs).toEqual([{ project: "trantor", seat: "kimi-9", id: "typescript:desktop" }]);
    await act(async () => { release(); await runGate; });
    await flush();
    expect(runButton()?.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Last run 14:02, 2 errors, 1 warning, 41 s");
  });

  it("groups diagnostics by file and opens the selected location", async () => {
    await mount();
    await run();
    const headings = [...host.querySelectorAll("h3")];
    expect(headings[0]?.textContent).toContain("desktop/src/a.ts");
    expect(headings[0]?.textContent).toContain("1 error, 1 warning");
    expect(headings[1]?.textContent).toContain("1 error, 0 warnings");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Open desktop/src/a.ts at 14:9"]')?.click();
    });
    expect(onOpen).toHaveBeenCalledWith("desktop/src/a.ts", 14, 9);
  });

  it("runs only the selected check", async () => {
    await mount();
    await choose("rust:src-tauri");
    await run();
    expect(runs).toEqual([{ project: "trantor", seat: null, id: "rust:src-tauri" }]);
  });

  it("shows the empty state without a Run button", async () => {
    checks = [];
    await mount();
    expect(host.textContent).toContain("No type check found in this project.");
    expect(runButton()).toBeNull();
    expect(runs).toEqual([]);
  });

  it("shows bounded raw output when a failed check has no parsed diagnostics", async () => {
    result = { items: [], exitCode: 2, durationMs: 1_500, raw: ["compiler could not start"], timedOut: false };
    await mount();
    await run();
    expect(host.querySelector('[aria-label="Raw check output"]')?.textContent).toContain("compiler could not start");
    expect(host.textContent).not.toContain("No problems found.");
  });

  it("formats counts and groups without changing their order", () => {
    expect(runSummary(RESULT, new Date(2026, 0, 2, 9, 5))).toBe("Last run 09:05, 2 errors, 1 warning, 41 s");
    expect(groupProblems(ITEMS).map(group => group.path)).toEqual(["desktop/src/a.ts", "desktop/src/b.ts"]);
  });
});
