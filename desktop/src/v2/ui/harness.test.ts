import { describe, expect, it } from "vitest";
import { harnessCapabilities } from "./harness";

describe("harness capabilities", () => {
  it("uses Claude's effort command and Trantor's autonomy control", () => {
    const controls = harnessCapabilities("claude");
    expect(controls.effort?.command(0)).toBe("/effort low");
    expect(controls.effort?.command(3)).toBe("/effort max");
    expect(controls.permission).toEqual({ kind: "autonomy" });
  });

  it("uses Codex's inline session commands with its real level and profile names", () => {
    const controls = harnessCapabilities("codex");
    expect(controls.effort?.command(0)).toBe("/model --reasoning low");
    expect(controls.effort?.command(1)).toBe("/model --reasoning medium");
    expect(controls.effort?.command(2)).toBe("/model --reasoning high");
    expect(controls.effort?.command(3)).toBe("/model --reasoning max");
    expect(controls.permission).toEqual({ kind: "command", commands: {
      ask: "/permissions :read-only",
      guarded: "/permissions :workspace",
      auto: "/permissions :danger-full-access",
    } });
  });

  it.each(["glm", "kimi", "deepseek", "qwen", "gemini", "unknown"])("hides unconfirmed controls for %s", agent => {
    const controls = harnessCapabilities(agent);
    expect(controls.effort).toBeUndefined();
    expect(controls.permission).toBeUndefined();
  });

  it("recognises provider aliases and numbered seats without inferring from a model", () => {
    expect(harnessCapabilities("openai").effort).toBeDefined();
    expect(harnessCapabilities("codex-8").permission?.kind).toBe("command");
    expect(harnessCapabilities("moonshot").effort).toBeUndefined();
    expect(harnessCapabilities("").effort).toBeUndefined();
  });
});
