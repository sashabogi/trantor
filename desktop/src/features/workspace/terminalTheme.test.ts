// #14351: the xterm theme mirrors the 2.0 tokens; this fails the moment theme.css and the mirror drift.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLOW_ECHO_MS, TERMINAL_FONT, TERMINAL_THEME, THEME_TOKENS } from "./terminalTheme";

const css = readFileSync(new URL("../../v2/theme.css", import.meta.url), "utf8");
const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)?.[1]?.toUpperCase();

describe("terminal theme", () => {
  it("reads every mirrored colour from its token", () => {
    for (const [key, name] of THEME_TOKENS) {
      expect(token(name), `${key} <- ${name}`).toBe(TERMINAL_THEME[key].toUpperCase());
    }
  });

  it("uses the spec's ANSI palette and an accent selection at 28%", () => {
    expect(TERMINAL_THEME).toMatchObject({ cyan: "#7FC8C8", brightRed: "#F0A5A5", brightGreen: "#9AD8B3", brightYellow: "#F6C96E", brightMagenta: "#DDC9FF", brightCyan: "#A5DADA" });
    expect(TERMINAL_THEME.selectionBackground).toBe("rgba(138, 168, 255, 0.28)");
  });

  it("sets the 2.0 mono stack at 12px with a 1.35 line height", () => {
    expect(TERMINAL_FONT).toMatchObject({ fontSize: 12, lineHeight: 1.35 });
    expect(css).toContain(`--v2-mono: ${TERMINAL_FONT.fontFamily}`);
    expect(SLOW_ECHO_MS).toBeGreaterThan(0);
  });
});
