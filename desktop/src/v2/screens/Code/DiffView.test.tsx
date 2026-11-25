// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DiffView } from "./DiffView";
import { parseUnifiedDiff } from "./diff";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patch = [
  "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt", "@@ -1,5 +1,5 @@ fn",
  " first", "-old one", "+new one", " middle", "-old two", "+new two", " last",
].join("\n");
const file = parseUnifiedDiff(patch)[0];
const deletionsOnly = parseUnifiedDiff([
  "diff --git a/b.txt b/b.txt", "index 3..4 100644", "--- a/b.txt", "+++ b/b.txt", "@@ -1,2 +0,0 @@", "-gone", "-also gone",
].join("\n"))[0];
const blame = [
  { line: 1, sha: "abcdef1234567890", author: "Tess", when: "2h ago", subject: "first" },
  { line: 2, sha: "abcdef1234567890", author: "Tess", when: "2h ago", subject: "first" },
  { line: 3, sha: "0123456789abcdef", author: "Ivo", when: "3d ago", subject: "second" },
  { line: 4, sha: "0123456789abcdef", author: "Ivo", when: "3d ago", subject: "second" },
  { line: 5, sha: "0123456789abcdef", author: "Ivo", when: "3d ago", subject: "second" },
];
let host: HTMLDivElement;
let root: Root;
let apply: ReturnType<typeof vi.fn>;
let blameAnswer: () => Promise<string>;

beforeEach(() => {
  apply = vi.fn().mockResolvedValue(undefined);
  blameAnswer = async () => JSON.stringify(blame);
  mockIPC(command => {
    if (command === "git_blame") return blameAnswer();
    if (command === "git_history") return JSON.stringify([]);
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const mount = async (side: "staged" | "unstaged" = "unstaged") => {
  await act(async () => {
    root.render(<DiffView files={[{ ...file, side }]} layout="combined" onLayout={() => {}} onAddToChat={() => {}} onApply={apply} />);
  });
  await flush();
};
const click = async (target: Element | null | undefined, shiftKey = false) => {
  await act(async () => { target?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey })); });
  await flush();
};
const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text);
const line = (index: number) => host.querySelector(`[data-line-index="${index}"]`);
const lastCall = () => apply.mock.calls[apply.mock.calls.length - 1];
const patchLabels = () =>
  [...host.querySelectorAll("button")].map(item => item.textContent).filter(text => /^(Stage|Unstage|Discard) /.test(text ?? ""));

describe("DiffView patch controls", () => {
  it("sends a complete hunk patch for stage, unstage and discard", async () => {
    for (const [label, action] of [["Stage hunk", "stage"], ["Unstage hunk", "unstage"], ["Discard hunk", "discard"]] as const) {
      await mount(action === "unstage" ? "staged" : "unstaged");
      await click(button(label));
      const call = lastCall();
      expect(call[1]).toBe(action);
      expect(call[2]).toBe("a.txt");
      expect(call[0]).toContain("diff --git a/a.txt b/a.txt");
      expect(call[0]).toContain("@@ -1,5 +1,5 @@ fn");
      expect(call[0]).toContain("-old one\n+new one");
    }
  });

  it("shows patch buttons whose labels follow the selection", async () => {
    await mount();
    expect(patchLabels()).toEqual(["Stage hunk", "Discard hunk"]);
    await click(line(1));
    await click(line(5), true);
    expect(patchLabels()).toEqual(["Stage 4 lines", "Discard 4 lines"]);
    await click(line(2));
    expect(patchLabels()).toEqual(["Stage 3 lines", "Discard 3 lines"]);
  });

  it("shift-selects a changed-line range and stages only those lines", async () => {
    await mount();
    await click(line(1));
    await click(line(5), true);
    expect(host.querySelectorAll("[data-selected=true]").length).toBe(4);
    await click(button("Stage 4 lines"));
    const selectedPatch = lastCall()[0];
    expect(selectedPatch).toContain("-old one\n+new one\n middle\n-old two\n+new two");
    expect(lastCall()[1]).toBe("stage");
  });

  it("unstaging one added line keeps the other addition as context and leaves the deletions out", async () => {
    await mount("staged");
    await click(line(2));
    expect(patchLabels()).toEqual(["Unstage 1 line"]);
    await click(button("Unstage 1 line"));
    const selectedPatch = lastCall()[0];
    expect(selectedPatch).toContain("@@ -1,4 +1,5 @@ fn");
    expect(selectedPatch).toContain(" first\n+new one\n middle\n new two\n last");
    expect(selectedPatch).not.toContain("old one");
    expect(lastCall()[1]).toBe("unstage");
  });

  it("shows a failed apply reason and keeps the selection for a refreshed diff", async () => {
    apply.mockRejectedValue(new Error("The patch no longer applies; the diff was refreshed."));
    await mount();
    await click(line(1));
    await click(button("Discard 1 line"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no longer applies");
    expect(line(1)?.getAttribute("data-selected")).toBe("true");
  });
});

describe("DiffView line history", () => {
  const mountHistory = async (layout: "combined" | "split", files = [file]) => {
    await act(async () => {
      root.render(<DiffView files={files} layout={layout} onLayout={() => {}} onAddToChat={() => {}} project="trantor" scope={null} />);
    });
    await flush();
    await click(host.querySelector('[aria-label="Line history"]'));
  };

  it("gives every diff row a blame cell matched by the old line number, and marks added lines as not committed", async () => {
    await mountHistory("combined");
    const cells = [...host.querySelectorAll("[data-blame-cell]")];
    expect(cells.length).toBe(7);
    const rowCells = [...host.querySelectorAll("[data-kind] [data-blame-cell]")];
    expect(rowCells.length).toBe(7);
    expect(rowCells[0].parentElement?.firstElementChild).toBe(rowCells[0]);
    expect(rowCells[0].textContent).toContain("Tess");
    expect(rowCells[0].textContent).toContain("2h ago");
    expect(rowCells[0].textContent).toContain("abcdef1");
    expect(rowCells[1].textContent).toContain("Tess");
    expect(rowCells[2].textContent).toBe("not committed");
    expect(rowCells[3].textContent).toContain("Ivo");
    expect(rowCells[3].textContent).toContain("3d ago");
    expect(rowCells[4].textContent).toContain("Ivo");
    expect(rowCells[5].textContent).toBe("not committed");
    expect(rowCells[6].textContent).toContain("0123456");
    expect(host.querySelector('[aria-label="Line history: a.txt"]')?.textContent).toContain("Ivo");
  });

  it("gives every paired row in side by side a blame cell from its old side", async () => {
    await mountHistory("split");
    const rowCells = [...host.querySelectorAll("[data-blame-cell]")];
    expect(rowCells.length).toBe(5);
    expect(rowCells[0].textContent).toContain("Tess");
    expect(rowCells[1].textContent).toContain("Tess");
    expect(rowCells[3].textContent).toContain("Ivo");
  });

  it("names the author of a removed line when a side by side row has no new side", async () => {
    await mountHistory("split", [deletionsOnly]);
    const cells = [...host.querySelectorAll("[data-blame-cell]")];
    expect(cells.length).toBe(2);
    expect(cells.every(cell => (cell.textContent ?? "").includes("Tess"))).toBe(true);
  });

  it("keeps the reading state and surfaces a blame error", async () => {
    blameAnswer = () => new Promise<string>(() => undefined);
    await mountHistory("combined");
    expect(host.textContent).toContain("Reading blame");
    await act(async () => { root.render(<div />); });
    blameAnswer = async () => { throw "fatal: no such path"; };
    await mountHistory("combined");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no such path");
  });

  it("opens file history from the diff header", async () => {
    await mountHistory("combined");
    await click(host.querySelector('[aria-label="File history for a.txt"]'));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("File history");
  });
});

// #14268: Unstage on a change that is not staged is a no-op the screen should not offer.
describe("DiffView patch actions by side", () => {
  it("offers Stage and Discard for unstaged changes without a section heading", async () => {
    await mount("unstaged");
    expect(patchLabels()).toEqual(["Stage hunk", "Discard hunk"]);
    expect(host.querySelector("h3")).toBeNull();
  });
  it("offers only Unstage for staged changes, by hunk and by line, without a section heading", async () => {
    await mount("staged");
    expect(patchLabels()).toEqual(["Unstage hunk"]);
    expect(host.querySelector("h3")).toBeNull();
    await click(line(1));
    expect(patchLabels()).toEqual(["Unstage 1 line"]);
  });
});
