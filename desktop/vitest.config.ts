import { defineConfig } from "vitest/config";

// Node by default: the modules under test are pure logic. happy-dom is opt-in per file
// (// @vitest-environment happy-dom) for the rare test that truly needs DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
