// quotePaths is the whole safety story of the terminal drop (#5949): the path arrives at the
// shell EXACTLY as the operator dropped it, whatever it contains.
import { describe, expect, it } from "vitest";
import { quotePaths } from "./quotePaths";

describe("quotePaths", () => {
  it("quotes a path with spaces whole", () => {
    expect(quotePaths(["/Users/me/My File.png"])).toBe("'/Users/me/My File.png'");
  });

  it("spells an embedded single quote the POSIX way", () => {
    expect(quotePaths(["/Users/me/it's.png"])).toBe("'/Users/me/it'\\''s.png'");
  });

  it("keeps unicode paths byte-for-byte", () => {
    expect(quotePaths(["/Users/me/照片 レポート.md"])).toBe("'/Users/me/照片 レポート.md'");
  });

  it("joins several paths space-separated, each quoted", () => {
    expect(quotePaths(["/a b.png", "/c's d.md"])).toBe("'/a b.png' '/c'\\''s d.md'");
  });

  it("nothing to drop writes nothing", () => {
    expect(quotePaths([])).toBe("");
  });
});
