// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { formatShortcut, inTerminal, matchesShortcut } from "./shortcuts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("matchesShortcut", () => {
  it("takes Command or Control for Mod and requires the exact shift state", () => {
    expect(matchesShortcut(key({ key: "p", metaKey: true }), "Mod+P")).toBe(true);
    expect(matchesShortcut(key({ key: "p", ctrlKey: true }), "Mod+P")).toBe(true);
    expect(matchesShortcut(key({ key: "p" }), "Mod+P")).toBe(false);
    expect(matchesShortcut(key({ key: "P", metaKey: true, shiftKey: true }), "Mod+P")).toBe(false);
    expect(matchesShortcut(key({ key: "P", metaKey: true, shiftKey: true }), "Mod+Shift+P")).toBe(true);
    expect(matchesShortcut(key({ key: "p", metaKey: true, altKey: true }), "Mod+P")).toBe(false);
  });

  it("matches the backtick by its key code and wants a literal Control", () => {
    expect(matchesShortcut(key({ key: "Dead", code: "Backquote", ctrlKey: true }), "Ctrl+`")).toBe(true);
    expect(matchesShortcut(key({ key: "`", metaKey: true }), "Ctrl+`")).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("spells the chord for a Mac and for other systems", () => {
    expect(formatShortcut("Mod+Shift+P", true)).toBe("⌘⇧P");
    expect(formatShortcut("Mod+Shift+P", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Ctrl+`", true)).toBe("⌃`");
    expect(formatShortcut("Ctrl+`", false)).toBe("Ctrl+`");
  });
});

describe("inTerminal", () => {
  it("is true only for a target inside an xterm", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="xterm"><textarea></textarea></div><textarea id="other"></textarea>';
    document.body.append(host);
    const fire = (el: Element | null) => {
      let seen = false;
      el?.addEventListener("keydown", e => { seen = e instanceof KeyboardEvent && inTerminal(e); }, { once: true });
      el?.dispatchEvent(key({ key: "p", bubbles: true }));
      return seen;
    };
    expect(fire(host.querySelector(".xterm textarea"))).toBe(true);
    expect(fire(host.querySelector("#other"))).toBe(false);
    host.remove();
  });
});
