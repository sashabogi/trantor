// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let style: HTMLStyleElement;
let host: HTMLDivElement;
beforeEach(() => {
  style = document.createElement("style");
  style.textContent = readFileSync("src/v2/theme.css", "utf8");
  document.head.append(style);
  host = document.createElement("div");
  host.className = "v2-root";
  document.body.append(host);
});
afterEach(() => { style.remove(); host.remove(); });

function rule(selector: string) {
  const found = Array.from(style.sheet?.cssRules ?? []).find(r => r instanceof CSSStyleRule && r.selectorText === selector);
  if (!(found instanceof CSSStyleRule)) throw new Error(`Missing style: ${selector}`);
  return found.style;
}

describe("focus and motion styles", () => {
  it("uses a soft ambient glow and thin edge gradients that brighten at the centre of each side", () => {
    const tokens = rule(":root");
    expect(tokens.getPropertyValue("--v2-focus-ring")).toBe("0 0 28px rgba(138,168,255,.12)");
    expect(tokens.getPropertyValue("--v2-focus-edge-horizontal")).toBe("linear-gradient(90deg, transparent 8%, rgba(138,168,255,.75) 50%, transparent 92%)");
    expect(tokens.getPropertyValue("--v2-focus-edge-vertical")).toBe("linear-gradient(180deg, transparent 12%, rgba(138,168,255,.55) 50%, transparent 88%)");
    expect(tokens.getPropertyValue("--v2-focus-glow-horizontal")).toContain("rgba(138,168,255,.35) 50%");
    expect(tokens.getPropertyValue("--v2-focus-glow-vertical")).toContain("rgba(138,168,255,.25) 50%");
    expect(rule(".v2-composer").borderWidth).toBe("1px");
    const edge = rule(".v2-composer::before");
    expect(edge.backgroundPosition).toBe("center top, center bottom, left center, right center");
    expect(edge.backgroundSize).toBe("100% 1px, 100% 1px, 1px 100%, 1px 100%");
    expect(edge.backgroundRepeat).toBe("no-repeat");
    expect(edge.backgroundColor).toBe("var(--v2-edge-2)");
    const glow = rule(".v2-composer::after");
    expect(glow.filter).toBe("blur(12px)");
    expect(glow.getPropertyValue("inset")).toBe("-3px");
    // the glow blurs thick strips so light survives; the visible edge above stays 1px
    expect(glow.backgroundSize).toBe("100% 6px, 100% 6px, 6px 100%, 6px 100%");
    expect(glow.zIndex).toBe("-1");
    expect(glow.opacity).toBe("0");
    expect(glow.transition).toContain("opacity var(--v2-dur-2)");
    expect([1, 2, 3].map(n => tokens.getPropertyValue(`--v2-dur-${n}`))).toEqual(["120ms", "180ms", "240ms"]);
    expect(rule(".v2-composer:focus-within").boxShadow).toBe("var(--v2-focus-ring)");
    expect(rule(".v2-composer:focus-within::before, .v2-composer:focus-within::after").opacity).toBe("1");
    expect(rule(".v2-composer .v2-composer-field").outlineStyle).toBe("none");
    expect(rule(".v2-composer .v2-composer-field").boxShadow).toBe("none");
  });

  it.each(["input", "select", "textarea"])("gives a focused %s the small ring", tag => {
    const field = document.createElement(tag);
    host.append(field);
    field.focus();
    expect(getComputedStyle(field).borderWidth).toBe("1px");
    expect(rule(":root").getPropertyValue("--v2-focus-edge-sm")).toBe("rgba(138,168,255,.60)");
    expect(getComputedStyle(field).outlineStyle).toBe("none");
    expect(getComputedStyle(field).boxShadow).toBe("0 0 10px rgba(138,168,255,.14)");
  });

  it("smooths tick width, opacity and colour over 200ms", () => {
    expect(rule(".v2-tick").transition).toBe("width 200ms var(--v2-ease), opacity 200ms var(--v2-ease), background-color 200ms var(--v2-ease)");
  });

  it("uses a single thin keyboard outline and a transitioning active pane edge", () => {
    expect(style.textContent).toContain(".v2-root :focus-visible { outline: 1px solid var(--v2-accent); outline-offset: 1px; }");
    expect(rule(".v2-root :focus-visible").outlineOffset).toBe("1px");
    expect(rule("[data-v2-pane]").transition).toContain("var(--v2-dur-3)");
    expect(rule("[data-v2-pane][data-active]").borderColor).toBe("var(--v2-active-edge)");
    expect(rule("[data-v2-pane][data-working]").animation).toContain("v2-breathe 2.4s");
  });

  it("disables all four animations and focus transitions under reduced motion", () => {
    const media = Array.from(style.sheet?.cssRules ?? []).filter((r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText === "(prefers-reduced-motion: reduce)");
    const rules = media.flatMap(r => Array.from(r.cssRules)).filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
    for (const selector of [".v2-pulse", ".v2-breathe", ".v2-sweep", ".v2-pop", "[data-v2-pane]", ".v2-composer", ".v2-composer::before", ".v2-composer::after", ".v2-tick"]) {
      const reset = rules.find(r => r.selectorText.split(",").map(s => s.trim()).includes(selector));
      expect(reset?.style.animation).toBe("none");
      expect(reset?.style.transition).toBe("none");
    }
    const tokens = rules.find(r => r.selectorText === ":root");
    expect([1, 2, 3].map(n => tokens?.style.getPropertyValue(`--v2-dur-${n}`))).toEqual(["0ms", "0ms", "0ms"]);
    expect(rule(".v2-sweep").left).toBe("30%");
  });
});
