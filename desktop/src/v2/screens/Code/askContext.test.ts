import { describe, expect, it } from "vitest";
import { buildAskContext, contextFromEditor } from "./askContext";

const sel = (startLine: number, endLine: number, text: string, endColumn = 5) => ({ startLine, startColumn: 1, endLine, endColumn, text });

describe("buildAskContext (#14073)", () => {
  it("fences a multi line selection under path:start-end", () => {
    expect(buildAskContext("a.ts", null, sel(10, 12, "x\ny\nz"))).toBe("a.ts:10-12\n```\nx\ny\nz\n```");
  });
  it("uses path:line for one line", () => {
    expect(buildAskContext("a.ts", null, sel(7, 7, "let a"))).toBe("a.ts:7\n```\nlet a\n```");
  });
  it("is just the path with no selection or an empty one", () => {
    expect(buildAskContext("a.ts", null, null)).toBe("a.ts");
    expect(buildAskContext("a.ts", null, sel(3, 3, ""))).toBe("a.ts");
  });
  it("does not count the next line when the selection ends at column 1", () => {
    expect(buildAskContext("a.ts", null, sel(2, 4, "a\nb\nc\n", 1))).toBe("a.ts:2-3\n```\na\nb\nc\n```");
  });
  it("treats a one line whole-line selection as one line", () => {
    expect(buildAskContext("a.ts", null, sel(5, 6, "only\n", 1))).toBe("a.ts:5\n```\nonly\n```");
  });
  it("caps the code at 200 lines and says how many were left out", () => {
    const text = Array.from({ length: 230 }, (_, i) => `l${i + 1}`).join("\n");
    const out = buildAskContext("a.ts", null, sel(1, 230, text));
    expect(out.endsWith("```\nand 30 more lines")).toBe(true);
    expect(out).toContain("l200\n```");
    expect(out).not.toContain("l201");
  });
  it("uses a longer fence than any backtick run inside", () => {
    expect(buildAskContext("a.md", null, sel(1, 1, "``` code ```"))).toBe("a.md:1\n````\n``` code ```\n````");
    expect(buildAskContext("a.md", null, sel(1, 1, "`````x")).split("\n")[1]).toBe("``````");
  });
  it("names the seat scope on the first line", () => {
    expect(buildAskContext("a.ts", "kimi-9", sel(10, 20, "x"))).toBe("a.ts:10-20 (seat kimi-9)\n```\nx\n```");
    expect(buildAskContext("a.ts", "kimi-9", null)).toBe("a.ts (seat kimi-9)");
  });
});

describe("contextFromEditor", () => {
  it("reads the selection and its text from the editor", () => {
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
    const ed = { getSelection: () => range, getModel: () => ({ getValueInRange: () => "abc" }) };
    expect(contextFromEditor(ed, "f.ts", null)).toBe("f.ts:1\n```\nabc\n```");
  });
  it("falls back to the path when nothing is selected", () => {
    const ed = { getSelection: () => null, getModel: () => null };
    expect(contextFromEditor(ed, "f.ts", null)).toBe("f.ts");
  });
});
