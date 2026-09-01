import { describe, expect, it } from "vitest";
import { modelLabel } from "./modelLabel";

describe("modelLabel", () => {
  it("a Claude id becomes the mark plus the version, the family rides the tooltip", () => {
    expect(modelLabel("claude-fable-5-1")).toEqual({ brand: "claude", short: "5.1", full: "Fable 5.1 (claude-fable-5-1)" });
    expect(modelLabel("claude-opus-5")).toEqual({ brand: "claude", short: "5", full: "Opus 5 (claude-opus-5)" });
    expect(modelLabel("claude-haiku-4-5")).toEqual({ brand: "claude", short: "4.5", full: "Haiku 4.5 (claude-haiku-4-5)" });
  });
  it("anything else is shown as it came, with no mark", () => {
    expect(modelLabel("gpt-5.5")).toEqual({ brand: null, short: "gpt-5.5", full: "gpt-5.5" });
    expect(modelLabel("")).toEqual({ brand: null, short: "", full: "" });
  });
});
