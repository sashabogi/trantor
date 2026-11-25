// #v2-F: monograms and colours match the artboard swatches.
import { describe, expect, it } from "vitest";
import { modelHue, modelLabel, monogram, projectGradient, seatAgent, seatLabel, seatPalette } from "./identity";

describe("monogram", () => {
  it("reads seat names the way the artboards print them", () => {
    expect(monogram("codex-8")).toBe("C8");
    expect(monogram("glm-5")).toBe("G5");
    expect(monogram("kimi-9")).toBe("K9");
    expect(monogram("orchestrator")).toBe("OR");
    expect(monogram("trantor-duty")).toBe("TD");
    expect(monogram("crebral-cortex")).toBe("CC");
    expect(monogram("claude:trantor-duty")).toBe("TD");
    expect(monogram("")).toBe("?");
  });

  it("drops the provider prefix from the readable label", () => {
    expect(seatLabel("codex:codex-8")).toBe("codex-8");
    expect(seatLabel("orchestrator")).toBe("orchestrator");
  });

  it("reads the seat, not the project, from a hub session id", () => {
    expect(seatLabel("codex-8:trantor")).toBe("codex-8");
    expect(monogram("kimi-9:trantor")).toBe("K9");
    expect(seatLabel("MacBook-Pro-M1:trantor")).toBe("orchestrator");
    expect(seatLabel("claude:trantor-duty")).toBe("trantor-duty");
    expect(seatPalette("MacBook-Pro-M1:trantor")).toEqual({ bg: "#3A2A24", fg: "#E39A7E" });
    expect(seatLabel("sasha@mac")).toBe("sasha@mac");
  });

  it("reads the agent a seat runs, so Swap never offers it back (#14062)", () => {
    expect(seatAgent("glm-5:trantor")).toBe("glm");
    expect(seatAgent("codex-8:trantor")).toBe("codex");
    expect(seatAgent("kimi:trantor")).toBe("kimi");
    expect(seatAgent("codex:codex-8")).toBe("codex");
    expect(seatAgent("claude:trantor-duty")).toBe("claude");
  });
});

describe("modelLabel", () => {
  it("gives every supported vendor a short readable model name", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(modelLabel("zai-coding-plan/glm-5.3")).toBe("GLM 5.3");
    expect(modelLabel("kimi-k2.7-code")).toBe("Kimi K2.7 Code");
    expect(modelLabel("deepseek/deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(modelLabel("qwen3-coder")).toBe("Qwen 3 Coder");
    expect(modelLabel("gemini-3-pro")).toBe("Gemini 3 Pro");
  });

  it("falls back to the exact id instead of inventing a name", () => {
    expect(modelLabel("vendor/custom-model")).toBe("vendor/custom-model");
    expect(modelLabel("opus")).toBe("opus");
  });
});

describe("colours", () => {
  it("gives each provider its artboard palette and unknown names a neutral one", () => {
    expect(seatPalette("orchestrator")).toEqual({ bg: "#3A2A24", fg: "#E39A7E" });
    expect(seatPalette("codex-8")).toEqual({ bg: "#1E2A26", fg: "#7FD8B8" });
    expect(seatPalette("glm-5")).toEqual({ bg: "#1E2338", fg: "#A9B8FF" });
    expect(seatPalette("kimi-9")).toEqual({ bg: "#2A2238", fg: "#CDB1FF" });
    expect(seatPalette("sasha")).toEqual({ bg: "#2A2E36", fg: "#E7E9EC" });
  });

  it("pins the artboard projects and hashes the rest deterministically", () => {
    expect(projectGradient("trantor")).toBe("linear-gradient(135deg, #4C6BC8, #2B3A5C)");
    expect(projectGradient("trantor-duty")).toBe("linear-gradient(135deg, #C77D4A, #3A2F28)");
    expect(projectGradient("constructor")).toMatch(/^linear-gradient/);
    expect(projectGradient("some-project")).toBe(projectGradient("some-project"));
  });

  it("tints model dots by family", () => {
    expect(modelHue("claude-opus-5-5")).toBe("#D97757");
    expect(modelHue("gpt-5-codex")).toBe("#7FD8B8");
    expect(modelHue("unknown")).toBe("#C4C8CE");
  });
});
