// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrandMark } from "../features/fleet/BrandMark";
import { Avatar } from "./Avatar";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #13062: the Codex mark is OpenAI's gradient cloud with a cut-out >_, the shape people know.
// The thin outline glyph from inside the ChatGPT app read as a blob at 13px.
const CLOUD = "M9.064 3.344a4.578 4.578 0 012.285-.312";
const OUTLINE_GLYPH = "M10.6843 1.50098";

describe("Codex brand mark", () => {
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

  async function markIn(node: React.ReactNode) {
    await act(async () => root.render(node));
    const svg = host.querySelector("svg");
    const paths = Array.from(svg?.querySelectorAll("path") ?? []);
    return { svg, paths };
  }

  it("seat avatar renders the gradient cloud, cropped to fill its box", async () => {
    const { svg, paths } = await markIn(<Avatar name="codex" />);
    expect(svg?.getAttribute("viewBox")).toBe("3 3 18 18");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d")).toContain(CLOUD);
    expect(paths[0].getAttribute("fill")).toBe("url(#trantor-codex-grad)");
    expect(svg?.querySelectorAll("stop")).toHaveLength(3);
    expect(svg?.innerHTML).not.toContain(OUTLINE_GLYPH);
  });

  it("footer chip renders the same gradient mark, not a currentColor path", async () => {
    const { svg, paths } = await markIn(<BrandMark icon="codex" mono="Cx" hue="#7A9DFF" fg="#fff" />);
    expect(svg?.getAttribute("viewBox")).toBe("3 3 18 18");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d")).toContain(CLOUD);
    expect(paths[0].getAttribute("fill")).toBe("url(#trantor-codex-grad)");
    expect(svg?.innerHTML).not.toContain(OUTLINE_GLYPH);
  });
});
