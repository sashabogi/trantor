// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_PATHS } from "../features/fleet/brands";
import { Avatar } from "./Avatar";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Avatar Codex brand", () => {
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

  it("renders OpenAI's official rounded-cloud mark and shares its geometry with fleet", async () => {
    await act(async () => root.render(<Avatar name="codex" />));
    const svg = host.querySelector("svg");
    const paths = Array.from(svg?.querySelectorAll("path") ?? [], path => path.getAttribute("d"));

    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe("M17.1088 14.5681C17.1088 15.1203 16.6611 15.5681 16.1088 15.5681H13.0277C12.4755 15.5681 12.0278 15.1203 12.0277 14.5681C12.0277 14.0158 12.4754 13.5681 13.0277 13.5681H16.1088C16.6611 13.5681 17.1088 14.0158 17.1088 14.5681Z");
    expect(paths[1]).toContain("M8.40468 8.43322");
    expect(paths[2]).toContain("M10.6843 1.50098");
    expect(paths.join(" ")).toBe(BRAND_PATHS.codex);
    expect(svg?.innerHTML).not.toContain("M8.086.457");
  });
});
