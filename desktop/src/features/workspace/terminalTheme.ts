// The seat terminal's xterm theme and font, a TypeScript mirror of the 2.0 tokens in v2/theme.css (#14351).
// terminalTheme.test.ts reads theme.css and fails if a mirrored colour drifts from its token.
export const TERMINAL_THEME = {
  background: "#111316", // --v2-terminal
  foreground: "#E7E9EC", // --v2-text
  cursor: "#8AA8FF", // --v2-accent
  selectionBackground: "rgba(138, 168, 255, 0.28)", // --v2-accent at 28%
  black: "#16181C", red: "#E58A8A", green: "#7CC49A", yellow: "#F2B544",
  blue: "#8AA8FF", magenta: "#CDB1FF", cyan: "#7FC8C8", white: "#C4C8CE",
  brightBlack: "#9AA0A8", brightRed: "#F0A5A5", brightGreen: "#9AD8B3", brightYellow: "#F6C96E",
  brightBlue: "#B3C6FF", brightMagenta: "#DDC9FF", brightCyan: "#A5DADA", brightWhite: "#E7E9EC",
} as const;

/** The mirrored colours and the token each one reads. */
export const THEME_TOKENS: readonly (readonly [keyof typeof TERMINAL_THEME, string])[] = [
  ["background", "--v2-terminal"], ["foreground", "--v2-text"], ["cursor", "--v2-accent"],
  ["black", "--v2-panel-2"], ["red", "--v2-bad"], ["green", "--v2-ok"], ["yellow", "--v2-warn"], ["blue", "--v2-accent"],
  ["magenta", "--v2-proposal"], ["white", "--v2-text-2"], ["brightBlack", "--v2-muted"], ["brightBlue", "--v2-accent-hi"], ["brightWhite", "--v2-text"],
];

/** The 2.0 mono stack (--v2-mono) at 12px, line height 1.35. */
export const TERMINAL_FONT = { fontSize: 12, lineHeight: 1.35, fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace' } as const;

/** The echo badge shows only when the round trip is slow. */
export const SLOW_ECHO_MS = 120;
