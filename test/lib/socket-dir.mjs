import { mkdirSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Relative socket addresses stay below macOS's 104-byte limit while files stay in the worktree.
export function shortSocketDir(prefix) {
  const out = fileURLToPath(new URL("../../.agent-bus-out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  return mkdtempSync(join(relative(process.cwd(), out), prefix));
}
