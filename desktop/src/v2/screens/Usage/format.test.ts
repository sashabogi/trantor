// #13991: the CSV export carries exactly the table's cells, quoted where needed.
import { describe, expect, it } from "vitest";
import { fmtTokens, toCsv } from "./format";
import { agentTable, projectTable } from "./tableData";
import type { AgentRow } from "./model";

describe("CSV export", () => {
  it("writes a header and one line per row, quoting commas and quotes", () => {
    expect(toCsv(["A", "B"], [["x", "1,200"], ['say "hi"', "2"]])).toBe('A,B\nx,"1,200"\n"say ""hi""",2\n');
  });

  it("exports the agent table's cells, n/a included", () => {
    const row: AgentRow = { agent: "codex", vendor: "Codex", models: ["default"], turns: 1234, failures: 100, points: [], machines: [], cardsDone: 3 };
    const t = agentTable([row]);
    expect(toCsv(t.head, t.rows)).toBe(
      'AGENT,VENDOR,MODELS,MACHINES,TURNS,WASTED TURNS,WASTED %,CARDS DONE\ncodex,Codex,cli-default,n/a,"1,234",100,8%,3\n');
  });

  it("marks a project with no API value as n/a instead of $0", () => {
    expect(projectTable([{ project: "p", turns: 2, failures: 0, notional: null }]).rows[0][3]).toBe("n/a");
  });

  it("formats big token counts compactly", () => {
    expect(fmtTokens(1_130_000_000)).toBe("1.13 B");
    expect(fmtTokens(38_000_000)).toBe("38.0 M");
  });
});
