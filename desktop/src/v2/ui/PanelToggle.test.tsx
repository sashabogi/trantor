// @vitest-environment happy-dom
// #14512: the PanelToggle primitive — states, drawing and access per docs/design/v2/PanelToggles.dc.html §B,
// plus the CSS that fades the fill on hover and stops under reduced motion.
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelToggle } from "./PanelToggle";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const toggled = vi.fn();
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); toggled.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async (props: Partial<Parameters<typeof PanelToggle>[0]> = {}) => {
  await act(async () => {
    root.render(<PanelToggle side="left" open tooltip="Hide source control ⌘B" onToggle={toggled} {...props} />);
  });
};
const button = () => host.querySelector<HTMLButtonElement>("button.v2-panel-toggle")!;

describe("PanelToggle button", () => {
  it("is a real button: aria-pressed is the state, the accessible name is the tooltip, and a click toggles", async () => {
    await mount({ open: true });
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().getAttribute("aria-label")).toBe("Hide source control ⌘B");
    expect(button().title).toBe("Hide source control ⌘B");
    await act(async () => { button().click(); });
    expect(toggled).toHaveBeenCalledOnce();
  });

  it("closed reports aria-pressed false and stays honest disabled, tooltip kept", async () => {
    await mount({ open: false, tooltip: "Show the bottom panel ⌘J" });
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().getAttribute("aria-label")).toBe("Show the bottom panel ⌘J");
    await mount({ open: false, disabled: true, tooltip: "No bottom panel on this screen" });
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("No bottom panel on this screen");
    await act(async () => { button().click(); });
    expect(toggled).not.toHaveBeenCalled();
  });

  it("carries side and state for the CSS, as a 20px drawing inside the 28px target", async () => {
    await mount({ side: "bottom", open: false });
    expect(button().dataset.side).toBe("bottom");
    expect(button().dataset.open).toBe("false");
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
    expect(svg.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the drawing per side (§B)", () => {
  it.each([
    ["left", "3.2", "4.2", "4.6", "M8 4v12"],
    ["bottom", "3.2", "11.2", "13.6", "M3 11h14"],
    ["right", "12.2", "4.2", "4.6", "M12 4v12"],
  ] as const)("a %s panel is the band where it sits, plus the divider where it would be", async (side, x, y, w, divider) => {
    await mount({ side });
    const shade = host.querySelector(".v2-pt-shade")!;
    expect(shade.getAttribute("x")).toBe(x);
    expect(shade.getAttribute("y")).toBe(y);
    expect(shade.getAttribute("width")).toBe(w);
    expect(host.querySelector(".v2-pt-divider")?.getAttribute("d")).toBe(divider);
  });

  it("the focus variant draws the maximised fill, the page square and the hover preview, no side shade", async () => {
    await mount({ side: "focus", open: true, tooltip: "Restore" });
    expect(host.querySelector(".v2-pt-focus-full")).not.toBeNull();
    expect(host.querySelector(".v2-pt-focus-in")).not.toBeNull();
    expect(host.querySelector(".v2-pt-focus-preview")).not.toBeNull();
    expect(host.querySelector(".v2-pt-shade")).toBeNull();
    expect(host.querySelector(".v2-pt-divider")).toBeNull();
  });
});

describe("the fade CSS (theme.css)", () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = readFileSync("src/v2/theme.css", "utf8");
    document.head.append(style);
  });
  afterEach(() => { style.remove(); });

  const rules = () => Array.from(style.sheet?.cssRules ?? []).filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
  const rule = (selector: string) => {
    const found = rules().find(r => r.selectorText === selector);
    if (!found) throw new Error(`Missing style: ${selector}`);
    return found.style;
  };

  it("sizes the 28px target and colours the states from the tokens", () => {
    const base = rule(".v2-panel-toggle");
    expect(base.width).toBe("28px");
    expect(base.height).toBe("28px");
    expect(base.color).toBe("var(--v2-text)");
    expect(rule('.v2-panel-toggle[data-open="false"]').color).toBe("var(--v2-muted)");
    expect(rule('.v2-panel-toggle[data-open="false"]:hover:not(:disabled)').color).toBe("var(--v2-text-2)");
  });

  it("fades the fill over 160ms: open to a third, closed in at 45; the divider shows closed only", () => {
    expect(rule(".v2-panel-toggle .v2-pt-shade").transition).toContain("opacity 160ms var(--v2-ease)");
    expect(rule('.v2-panel-toggle[data-open="false"] .v2-pt-shade').opacity).toBe("0");
    expect(rule('.v2-panel-toggle[data-open="true"]:hover:not(:disabled) .v2-pt-shade').opacity).toBe("0.35");
    expect(rule('.v2-panel-toggle[data-open="false"]:hover:not(:disabled) .v2-pt-shade').opacity).toBe("0.45");
    expect(rule('.v2-panel-toggle[data-open="false"] .v2-pt-divider').opacity).toBe("1");
    expect(rule('.v2-panel-toggle[data-open="false"]:hover:not(:disabled) .v2-pt-divider').opacity).toBe("0");
  });

  it("the focus variant swaps geometry on hover at §B's opacities", () => {
    expect(rule('.v2-panel-toggle[data-open="true"] .v2-pt-focus-full').opacity).toBe("1");
    expect(rule('.v2-panel-toggle[data-open="true"]:hover:not(:disabled) .v2-pt-focus-full').opacity).toBe("0");
    const hovered = rule('.v2-panel-toggle[data-open="true"]:hover:not(:disabled) .v2-pt-focus-in');
    expect(hovered.fill).toBe("currentColor");
    expect(hovered.fillOpacity).toBe("0.5");
    expect(rule('.v2-panel-toggle[data-open="false"]:hover:not(:disabled) .v2-pt-focus-preview').opacity).toBe("0.3");
  });

  it("stops the fade under reduced motion", () => {
    const media = Array.from(style.sheet?.cssRules ?? []).filter((r): r is CSSMediaRule =>
      r instanceof CSSMediaRule && r.conditionText === "(prefers-reduced-motion: reduce)");
    const reset = media.flatMap(r => Array.from(r.cssRules)).filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
      .find(r => r.selectorText.split(",").map(s => s.trim()).includes(".v2-panel-toggle .v2-pt-shade"));
    expect(reset?.style.transition).toBe("none");
  });
});
