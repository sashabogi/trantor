// @vitest-environment happy-dom
// #14018: the composer names the model of whichever vendor orchestrates, and offers Claude's controls to Claude only.
import { describe, expect, it } from "vitest";
import { isClaudeHosted, shownModel } from "./ComposerAdapter";

describe("the orchestrator's model in the composer", () => {
  it("gives every vendor a readable name, not a raw id", () => {
    expect(shownModel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(shownModel("gpt-5-codex")).toBe("GPT 5 Codex");
    expect(shownModel("zai-coding-plan/glm-5.3")).toBe("GLM 5.3");
    expect(shownModel(undefined)).toBe("model unknown");
  });

  it("offers Claude Code's model and effort commands to Claude only", () => {
    expect(isClaudeHosted("claude-opus-5-5")).toBe(true);
    expect(isClaudeHosted(undefined)).toBe(true);
    expect(isClaudeHosted("gpt-5-codex")).toBe(false);
    expect(isClaudeHosted("zai-coding-plan/glm-5.3")).toBe(false);
  });
});
