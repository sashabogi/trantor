// The disk-guard's two pure decisions (#5811): the signature is stable and content-sensitive, and
// the verdict table never flags a tab whose draft matches disk or whose disk did not move.
import { describe, expect, it } from "vitest";
import { diskSignature, externalMutationOnLoad } from "./tabGuard";

describe("diskSignature", () => {
  it("is stable for equal text and differs when content differs", () => {
    expect(diskSignature("const a = 1;")).toBe(diskSignature("const a = 1;"));
    expect(diskSignature("const a = 1;")).not.toBe(diskSignature("const a = 2;"));
  });

  it("changes with a one-character edit and with leading/trailing whitespace", () => {
    expect(diskSignature("hello")).not.toBe(diskSignature("hellp"));
    expect(diskSignature("hello")).not.toBe(diskSignature(" hello"));
    expect(diskSignature("hello")).not.toBe(diskSignature("hello\n"));
  });

  it("handles the empty string and large-ish text without colliding trivially", () => {
    expect(diskSignature("")).toBe("811c9dc5");
    const big = "x".repeat(100_000);
    expect(diskSignature(big)).toBe(diskSignature(big));
    expect(diskSignature(big)).not.toBe(diskSignature(`${big}x`));
  });
});

describe("externalMutationOnLoad", () => {
  const sig = (t: string) => diskSignature(t);

  it("never flags a tab with no draft", () => {
    expect(externalMutationOnLoad({ draft: null, baseSignature: sig("old"), diskText: "new" })).toBeNull();
  });

  it("never flags a clean tab whose draft already matches disk", () => {
    expect(externalMutationOnLoad({ draft: "same", baseSignature: sig("whatever"), diskText: "same" })).toBeNull();
  });

  it("does not flag when the disk text is what the draft was based on", () => {
    expect(externalMutationOnLoad({ draft: "my edits", baseSignature: sig("disk"), diskText: "disk" })).toBeNull();
  });

  it("flags moved when the disk changed away from the draft's baseline", () => {
    expect(externalMutationOnLoad({ draft: "my edits", baseSignature: sig("disk"), diskText: "agent wrote this" })).toBe("moved");
  });

  it("still flags when no baseline was recorded yet and the draft is not the disk", () => {
    expect(externalMutationOnLoad({ draft: "my edits", baseSignature: null, diskText: "disk" })).toBe("moved");
  });
});
