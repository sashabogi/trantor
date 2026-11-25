// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { availableCommands, filterCommands, fuzzyScore, getCommands, registerCommands, useRegisterCommands, type Command } from "./commands";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const cmd = (id: string, title: string, extra: Partial<Command> = {}): Command => ({ id, title, group: "Go to", run: () => undefined, ...extra });

describe("registry", () => {
  it("adds, replaces by id and removes only what the caller added", () => {
    const first = cmd("t.a", "First");
    const second = cmd("t.a", "Second");
    const off1 = registerCommands([first]);
    const off2 = registerCommands([second]);
    expect(getCommands().find(c => c.id === "t.a")?.title).toBe("Second");
    off1();
    expect(getCommands().find(c => c.id === "t.a")?.title).toBe("Second");
    off2();
    expect(getCommands().some(c => c.id === "t.a")).toBe(false);
  });

  it("hides a command whose when test fails", () => {
    const list = [cmd("t.b", "Shown"), cmd("t.c", "Hidden", { when: () => false })];
    expect(availableCommands(list).map(c => c.id)).toEqual(["t.b"]);
  });
});

describe("useRegisterCommands", () => {
  function Probe({ onRun }: { onRun: () => void }) {
    useRegisterCommands([cmd("t.hook", "Hook command", { run: onRun })]);
    return null;
  }

  it("registers while mounted and runs the latest closure", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const a = vi.fn();
    const b = vi.fn();
    act(() => root.render(<Probe onRun={a} />));
    act(() => root.render(<Probe onRun={b} />));
    getCommands().find(c => c.id === "t.hook")?.run();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(getCommands().some(c => c.id === "t.hook")).toBe(false);
  });
});

describe("matching", () => {
  it("needs every letter in order and prefers letters together", () => {
    expect(fuzzyScore("xyz", "Go to file")).toBeNull();
    expect(fuzzyScore("gtf", "Go to file")).not.toBeNull();
    expect(fuzzyScore("file", "Go to file")).toBeGreaterThan(fuzzyScore("fle", "Go to file") ?? 0);
  });

  it("ranks the best title first and keeps registration order without a query", () => {
    const list = [cmd("1", "Toggle bottom panel", { group: "View" }), cmd("2", "Go to file"), cmd("3", "Go to Board")];
    expect(filterCommands(list, "").map(c => c.id)).toEqual(["2", "3", "1"]);
    expect(filterCommands(list, "board")[0].id).toBe("3");
    expect(filterCommands(list, "zzz")).toEqual([]);
  });
});
