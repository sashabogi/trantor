import { describe, expect, it } from "vitest";
import { safePath } from "./fileApi";

describe("safePath", () => {
  it("accepts a simple relative path", () => {
    expect(safePath("src/foo.ts")).toBe(true);
  });

  it("accepts a path in a subdirectory", () => {
    expect(safePath("src/components/App.tsx")).toBe(true);
  });

  it("rejects a path with parent traversal", () => {
    expect(safePath("../etc/passwd")).toBe(false);
  });

  it("rejects a path with parent traversal in the middle", () => {
    expect(safePath("src/../etc/passwd")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(safePath("/etc/passwd")).toBe(false);
  });

  it("rejects a path that starts with a slash", () => {
    expect(safePath("/home/user/project/file.ts")).toBe(false);
  });

  it("accepts a single filename with no directory", () => {
    expect(safePath("README.md")).toBe(true);
  });
});