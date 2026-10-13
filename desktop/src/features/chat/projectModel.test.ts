import { describe, expect, it, vi } from "vitest";
import { dialModel, projectModelApi } from "./projectModel";

describe("the model dial's value (#11657)", () => {
  const local = { model: "opus", source: "local" as const };
  const global = { model: "sonnet", source: "global" as const };

  it("a dispatch outranks everything, then the session's report, then the project's setting", () => {
    expect(dialModel("fable", "claude-opus-4-1", "reported", local)).toEqual({ model: "fable", source: "dispatched" });
    expect(dialModel("", "claude-opus-4-1", "reported", local)).toEqual({ model: "claude-opus-4-1", source: "reported" });
    expect(dialModel("", "", "unknown", local)).toEqual({ model: "opus", source: "configured" });
    expect(dialModel("", "", "unknown", null)).toEqual({ model: "", source: "unknown" });
  });

  it("two projects with no session yet each show their own effective model", () => {
    expect(dialModel("", "", "unknown", local).model).toBe("opus");
    expect(dialModel("", "", "unknown", global).model).toBe("sonnet");
  });

  it("reads the Rust answer and treats a refusal or junk as nothing configured", async () => {
    const ok = vi.fn().mockResolvedValue('{"model":"opus","source":"local"}');
    // SAFETY: the mock only answers project_model_get with the one string the code under test reads.
    expect(await projectModelApi.get("p", ok as never)).toEqual({ model: "opus", source: "local" });
    expect(ok).toHaveBeenCalledWith("project_model_get", { project: "p" });
    // SAFETY: the mock only answers project_model_get with the one string the code under test reads.
    expect(await projectModelApi.get("p", vi.fn().mockResolvedValue('{"model":null,"source":null}') as never)).toBeNull();
    // SAFETY: the mock only rejects project_model_get, which is all the code under test calls.
    expect(await projectModelApi.get("p", vi.fn().mockRejectedValue(new Error("x")) as never)).toBeNull();
  });
});
