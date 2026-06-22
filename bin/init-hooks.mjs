#!/usr/bin/env node
// trantor init-hooks — install a git post-commit hook in the current repo so EVERY commit is
// auto-carded onto the board. This is the reliable backstop for solo work: a session that doesn't
// fire a crew and doesn't keep a live TodoWrite leaves no work-card otherwise (only presence). The
// hook calls `trantor backfill` (idempotent, theme-grouped) in the background — never slows a commit.
//
// Usage: trantor init-hooks [--since "5 minutes ago"] [--uninstall]
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const since = arg("since", "5 minutes ago");
const uninstall = args.includes("--uninstall");

const MARK_START = "# >>> trantor auto-card (post-commit) >>>";
const MARK_END = "# <<< trantor auto-card (post-commit) <<<";

let gitDir;
try { gitDir = execSync("git rev-parse --git-dir", { encoding: "utf8", cwd: process.cwd() }).trim(); }
catch { console.error("not a git repository (run this inside a repo)"); process.exit(1); }

const hooksDir = join(gitDir, "hooks");
const hookPath = join(hooksDir, "post-commit");
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

// the trantor block — fail-silent, non-blocking, PATH-robust
const block = [
  MARK_START,
  "# Card this commit onto the trantor board. Non-blocking + fail-silent: never slows/breaks a commit.",
  'TRANTOR_BIN="$(command -v trantor 2>/dev/null)"',
  '[ -z "$TRANTOR_BIN" ] && [ -x /opt/homebrew/bin/trantor ] && TRANTOR_BIN=/opt/homebrew/bin/trantor',
  '[ -z "$TRANTOR_BIN" ] && [ -x /usr/local/bin/trantor ] && TRANTOR_BIN=/usr/local/bin/trantor',
  `[ -n "$TRANTOR_BIN" ] && ( "$TRANTOR_BIN" backfill --since ${JSON.stringify(since)} >/dev/null 2>&1 & )`,
  MARK_END,
].join("\n");

let existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";

// strip any prior trantor block (idempotent install / clean uninstall)
const stripped = existing.replace(new RegExp(`\\n?${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}\\n?`, "g"), "\n").replace(/\n{3,}/g, "\n\n");

if (uninstall) {
  if (!existing.includes(MARK_START)) { console.log("no trantor post-commit hook installed — nothing to remove"); process.exit(0); }
  const out = stripped.trim();
  if (out && out !== "#!/bin/sh") { writeFileSync(hookPath, out.endsWith("\n") ? out : out + "\n"); }
  else { writeFileSync(hookPath, "#!/bin/sh\n"); }
  console.log(`✓ removed trantor auto-card from ${hookPath}`);
  process.exit(0);
}

let out;
if (!stripped.trim()) {
  out = `#!/bin/sh\n${block}\n`;
} else {
  const base = stripped.trim().startsWith("#!") ? stripped.trimEnd() : `#!/bin/sh\n${stripped.trimEnd()}`;
  out = `${base}\n\n${block}\n`;
}
writeFileSync(hookPath, out);
chmodSync(hookPath, 0o755);
console.log(`✓ installed trantor auto-card → ${hookPath}`);
console.log(`  every commit now cards itself on the board (backfill --since ${JSON.stringify(since)}, idempotent).`);
console.log(`  remove with: trantor init-hooks --uninstall`);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
