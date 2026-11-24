// #v2-F: monograms and colours match the artboard swatches.
import { describe, expect, it } from "vitest";
import { modelHue, monogram, projectGradient, seatLabel, seatPalette } from "./identity";

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
