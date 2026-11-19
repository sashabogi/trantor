#!/usr/bin/env node
// trantor PostToolUse(Bash|relay_task_move): one dated line in the project's current-state memory
// file per commit and per card move, so a weeks-long session is not summarized only at the end
// (#13871). Fail-silent by contract: never blocks or breaks the tool flow.
import { execFileSync } from "node:child_process";
import { appendProgress } from "./lib/current-state.mjs";
import { gitCheckoutRoot } from "./lib/git-checkout.mjs";
import { readStdinWithin, failOpenAfter } from "./lib/fail-open.mjs";

const MOVE_TOOL = /relay_task_move$/;
const COMMIT_CMD = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const FRESH_SEC = 120;

/** The commit this Bash call just made, or "" when none landed (a failed commit changes HEAD's age not). */
export function justCommitted(cwd, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    const out = execFileSync("git", ["-C", cwd, "log", "-1", "--format=%h%x09%ct%x09%s"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const [sha, ct, ...subject] = out.split("\t");
    return nowSec - Number(ct) <= FRESH_SEC ? `commit ${sha} ${subject.join("\t")}` : "";
  } catch { return ""; }
}

/** The progress line for one hook event, or "". */
export function progressFor(input) {
  const name = String(input.tool_name || "");
  if (MOVE_TOOL.test(name)) {
    if (JSON.stringify(input.tool_response ?? "").includes("\"isError\":true")) return "";
    const { id, status, note } = input.tool_input || {};
    return id && status ? `card #${id} -> ${status}${note ? `: ${String(note).slice(0, 120)}` : ""}` : "";
  }
  if (name === "Bash" && COMMIT_CMD.test(String(input.tool_input?.command || ""))) return justCommitted(input.cwd || process.cwd());
  return "";
}

async function main() {
  failOpenAfter(4000, "");
  const input = JSON.parse((await readStdinWithin(300)) || "{}");
  const line = progressFor(input);
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (line) appendProgress(gitCheckoutRoot(cwd) || cwd, line);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {}).finally(() => process.exit(0));
