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
  it("uses the approved artboard glow and motion timings", () => {
    const tokens = rule(":root");
    expect(tokens.getPropertyValue("--v2-focus-ring")).toBe("0 0 0 4px rgba(138,168,255,.20), 0 0 22px 2px rgba(138,168,255,.18), 0 12px 32px -16px rgba(0,0,0,.6)");
    expect(tokens.getPropertyValue("--v2-focus-edge-top")).toBe("rgba(138,168,255,.80)");
    expect(tokens.getPropertyValue("--v2-focus-edge-bottom")).toBe("rgba(138,168,255,.35)");
    expect([1, 2, 3].map(n => tokens.getPropertyValue(`--v2-dur-${n}`))).toEqual(["120ms", "180ms", "240ms"]);
    expect(rule(".v2-composer:focus-within").boxShadow).toBe("var(--v2-focus-ring)");
    expect(rule(".v2-composer:focus-within::before").opacity).toBe("1");
    expect(rule(".v2-composer .v2-composer-field").outlineStyle).toBe("none");
    expect(rule(".v2-composer .v2-composer-field").boxShadow).toBe("none");
  });

  it.each(["input", "select", "textarea"])("gives a focused %s the small ring", tag => {
    const field = document.createElement(tag);
    host.append(field);
    field.focus();
    expect(getComputedStyle(field).outlineStyle).toBe("none");
    expect(getComputedStyle(field).boxShadow).toBe("0 0 0 3px rgba(138,168,255,.18), 0 0 14px rgba(138,168,255,.14)");
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
    for (const selector of [".v2-pulse", ".v2-breathe", ".v2-sweep", ".v2-pop", "[data-v2-pane]", ".v2-composer", ".v2-composer::before"]) {
      const reset = rules.find(r => r.selectorText.split(",").map(s => s.trim()).includes(selector));
      expect(reset?.style.animation).toBe("none");
      expect(reset?.style.transition).toBe("none");
    }
    const tokens = rules.find(r => r.selectorText === ":root");
    expect([1, 2, 3].map(n => tokens?.style.getPropertyValue(`--v2-dur-${n}`))).toEqual(["0ms", "0ms", "0ms"]);
    expect(rule(".v2-sweep").left).toBe("30%");
  });
});
