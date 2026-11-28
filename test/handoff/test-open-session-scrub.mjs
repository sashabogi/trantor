#!/usr/bin/env node
// #14531: the Terminal fallback of a handoff starts its session with the caller's identity unset,
// or the new session registers itself with a herdr pane it is not in and runs with transcripts off.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
console.log("# open-session identity scrub");
const script = fileURLToPath(new URL("../../bin/open-session.sh", import.meta.url));
const env = { ...process.env, TRANTOR_OPEN_SESSION_PRINT: "1", HERDR_PANE_ID: "w2R:p2N", CLAUDE_CODE_CHILD_SESSION: "1" };
const r = spawnSync("/bin/bash", [script, "/tmp/a dir", "claude --resume x"], { env, encoding: "utf8" });
const line = r.stdout.trim();
ok("print mode exits 0 without opening Terminal", r.status === 0, r.stderr);
for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH", "TRANTOR_ORCH", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"]) {
  ok(`${k} is unset before the command`, new RegExp(`^unset [^;]*\\b${k}\\b[^;]*;`).test(line), line);
}
ok("the command runs after the scrub, in the quoted dir", line.endsWith("; cd /tmp/a\\ dir && claude --resume x"), line);
// The line is what Terminal's shell runs: prove it really clears the inherited values.
const run = spawnSync("/bin/bash", ["-c", line.replace("claude --resume x", 'echo "[$HERDR_PANE_ID][$CLAUDE_CODE_CHILD_SESSION]"').replace("cd /tmp/a\\ dir", "cd /tmp")], { env, encoding: "utf8" });
ok("a shell running the line sees no pane id and no child marker", run.stdout.trim() === "[][]", run.stdout + run.stderr);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
