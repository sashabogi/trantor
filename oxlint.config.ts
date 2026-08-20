// trantor lint — the anti-slop gate (vendored from dmmulroy/anti-slop; the rules are OURS to
// tune now). Scope: the TS surface (desktop/src) plus the JS-applicable rules over hooks/bin/lib.
// hub.mjs and mcp.mjs are excluded on purpose: 390-char generated-style lines predate the gate;
// bin/slop-gate.mjs lints CHANGED files only, so new work in them is still gated.
import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".claude/**",
    ".dsh/**",
    "node_modules/**",
    "desktop/node_modules/**",
    "desktop/src-tauri/**",
    "desktop/dist/**",
    "tools/oxlint/anti-slop/**",
    "engine/**",
    "kimi/skills/**",
    "docs/**",
    "hub.mjs",
    "mcp.mjs",
    "ui.html",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
