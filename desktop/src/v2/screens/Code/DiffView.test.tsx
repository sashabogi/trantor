// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffView } from "./DiffView";
import { parseUnifiedDiff } from "./diff";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patch = [
  "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt", "@@ -1,5 +1,5 @@ fn",
  " first", "-old one", "+new one", " middle", "-old two", "+new two", " last",
].join("\n");
const file = parseUnifiedDiff(patch)[0];
let host: HTMLDivElement;
let root: Root;
let apply: ReturnType<typeof vi.fn>;

beforeEach(() => {
  apply = vi.fn().mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const mount = async () => {
  await act(async () => {
    root.render(<DiffView files={[file]} layout="combined" onLayout={() => {}} onAddToChat={() => {}} onApply={apply} />);
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

describe("DiffView patch controls", () => {
  it("sends a complete hunk patch for stage, unstage and discard", async () => {
    await mount();
    for (const [label, action] of [["Stage hunk", "stage"], ["Unstage hunk", "unstage"], ["Discard hunk", "discard"]] as const) {
      await click(button(label));
      const call = lastCall();
      expect(call[1]).toBe(action);
      expect(call[2]).toBe("a.txt");
      expect(call[0]).toContain("diff --git a/a.txt b/a.txt");
      expect(call[0]).toContain("@@ -1,5 +1,5 @@ fn");
      expect(call[0]).toContain("-old one\n+new one");
    }
  });

  it("shift-selects a changed-line range and stages only those lines", async () => {
    await mount();
    await click(line(1));
    await click(line(5), true);
    expect(host.querySelectorAll("[data-selected=true]").length).toBe(4);
    await click(button("Stage lines"));
    const selectedPatch = lastCall()[0];
    expect(selectedPatch).toContain("-old one\n+new one\n middle\n-old two\n+new two");
    expect(lastCall()[1]).toBe("stage");
  });

  it("unstaging one added line keeps the other addition as context and leaves the deletions out", async () => {
    await mount();
    await click(line(2));
    await click(button("Unstage lines"));
    const selectedPatch = lastCall()[0];
    expect(selectedPatch).toContain("@@ -1,4 +1,5 @@ fn");
    expect(selectedPatch).toContain(" first\n+new one\n middle\n new two\n last");
    expect(selectedPatch).not.toContain("old one");
    expect(lastCall()[1]).toBe("unstage");
  });

  it("shows a failed apply reason and keeps the selection for a refreshed diff", async () => {
    apply.mockRejectedValue(new Error("The patch no longer applies; the diff was refreshed."));
    await mount();
    await click(button("Discard lines"));
    expect(apply).not.toHaveBeenCalled();
    await click(line(1));
    await click(button("Discard lines"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no longer applies");
    expect(line(1)?.getAttribute("data-selected")).toBe("true");
  });
});
