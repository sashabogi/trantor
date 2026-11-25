import { describe, expect, it } from "vitest";
import { draftDrop, draftFor, draftKeep } from "./drafts";

describe("drafts (#14072)", () => {
  it("keeps an unsaved draft per project, scope and path", () => {
    draftKeep("p1", null, "src/a.ts", "one");
    draftKeep("p1", "glm-5", "src/a.ts", "two");
    expect(draftFor("p1", null, "src/a.ts")).toBe("one");
    expect(draftFor("p1", "glm-5", "src/a.ts")).toBe("two");
    expect(draftFor("p1", null, "src/b.ts")).toBeNull();
    expect(draftFor("p2", null, "src/a.ts")).toBeNull();
  });

  it("dropping the draft leaves nothing to resume, and dropping again is fine", () => {
    draftKeep("p3", null, "src/c.ts", "kept");
    draftDrop("p3", null, "src/c.ts");
    expect(draftFor("p3", null, "src/c.ts")).toBeNull();
    draftDrop("p3", null, "src/c.ts");
    expect(draftFor("p3", null, "src/c.ts")).toBeNull();
  });
});
