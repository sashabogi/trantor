import { describe, expect, it } from "vitest";
import { unifiedDiffToken } from "./unifiedDiff";

describe("unified diff tokens", () => {
  it("colors added and removed lines like the local diff palette", () => {
    expect(unifiedDiffToken("+const added = true;")).toBe("markup.inserted");
    expect(unifiedDiffToken("-const removed = true;")).toBe("markup.deleted");
  });

  it("styles hunk and file headers without treating +++ or --- as changes", () => {
    expect(unifiedDiffToken("@@ -1 +1 @@")).toBe("meta.diff.header");
    expect(unifiedDiffToken("+++ b/a.ts")).toBe("meta.diff.file");
    expect(unifiedDiffToken("--- a/a.ts")).toBe("meta.diff.file");
  });

  it("leaves context unstyled and mutes no-newline markers", () => {
    expect(unifiedDiffToken(" const same = true;")).toBe("");
    expect(unifiedDiffToken("\\ No newline at end of file")).toBe("comment");
  });
});
