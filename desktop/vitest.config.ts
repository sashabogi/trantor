import { realpathSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Node by default: the modules under test are pure logic. happy-dom is opt-in per file
// (// @vitest-environment happy-dom) for the rare test that truly needs DOM.
export default defineConfig({
  // #14264: worktrees share installed dependencies, including SVG assets loaded through Vite.
  server: { fs: { allow: [realpathSync(new URL(".", import.meta.url)), realpathSync(new URL("./node_modules", import.meta.url))] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
