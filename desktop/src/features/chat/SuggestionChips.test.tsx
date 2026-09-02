// @vitest-environment happy-dom
//
// The bounce assertion (#5929): the chips row is really MOUNTED — buttons with the chip labels
// and tooltips, above-the-composer placement owned by Chat, pick and dismiss wired.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionChips } from "./SuggestionChips";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SuggestionChips", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mounts a button per chip with its tooltip, and a dismiss control", () => {
    act(() => root.render(
      <SuggestionChips
        suggestions={[{ text: "push it" }, { text: "1", tooltip: "Land the tab strip first" }]}
        onPick={() => {}}
        onDismiss={() => {}}
      />,
    ));
    const row = host.querySelector('[data-testid="suggestion-chips"]')!;
    expect(row).not.toBeNull();
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map(b => b.textContent)).toEqual(["push it", "1", "×"]);
    expect(buttons[1].title).toBe("Land the tab strip first");
  });

  it("a chip click reports exactly its text; dismiss reports dismissal", () => {
    const onPick = vi.fn();
    const onDismiss = vi.fn();
    act(() => root.render(
      <SuggestionChips suggestions={[{ text: "push it" }]} onPick={onPick} onDismiss={onDismiss} />,
    ));
    const buttons = [...host.querySelectorAll("button")];
    act(() => { buttons[0].click(); });
    act(() => { buttons[1].click(); });
    expect(onPick).toHaveBeenCalledWith("push it");
    expect(onDismiss).toHaveBeenCalled();
  });
});
