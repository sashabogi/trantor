#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const bus = mkdtempSync(join(tmpdir(), "trantor-ask-sidecar-"));
const cwd = mkdtempSync(join(tmpdir(), "trantor-ask-project-"));
const sid = "8ccf328e-ecf9-4322-903d-ca44546e6212";
const sidecar = join(bus, "asks", `${sid}.json`);
let pass = 0, fail = 0;
const ok = (condition, name) => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
};

function run(payload) {
  return spawnSync("node", [join(ROOT, "hooks/ask-sidecar.mjs")], {
    input: JSON.stringify(payload),
    env: { ...drillEnv(), AGENT_BUS_DIR: bus, RELAY_PROJECT: "trantor", HOME: bus },
    encoding: "utf8",
    timeout: 10_000,
  });
}

const questions = [{
  question: "Which release lane?",
  header: "Lane",
  multiSelect: false,
  options: [
    { label: "Stable", description: "Use the tested lane" },
    { label: "Canary", description: "Use the preview lane" },
  ],
}];
const open = {
  hook_event_name: "PreToolUse",
  session_id: sid,
  transcript_path: join(cwd, `${sid}.jsonl`),
  cwd,
  permission_mode: "default",
  tool_name: "AskUserQuestion",
  tool_input: { questions },
  tool_use_id: "toolu_01JASK",
};

console.log("# trantor AskUserQuestion sidecar tests");

const opened = run(open);
const created = JSON.parse(readFileSync(sidecar, "utf8"));
ok(opened.status === 0 && opened.stdout === "{}", "real-shaped PreToolUse returns no decision");
ok(created.session_id === sid && created.project === "trantor" && created.cwd === cwd,
   "open sidecar records session, project, and cwd");
ok(created.tool_use_id === open.tool_use_id && JSON.stringify(created.questions) === JSON.stringify(questions),
   "open sidecar preserves tool id and questions");
ok(Number.isFinite(created.ts), "open sidecar carries an epoch timestamp");
ok(created.event === "PreToolUse" && created.visible_ts === null,
   "PreToolUse records an ask that is not visible yet");

run({ ...open, hook_event_name: "PostToolUse", tool_use_id: "toolu_OTHER" });
ok(existsSync(sidecar), "a stale close cannot erase a newer identified ask");
run({ ...open, hook_event_name: "PostToolUseFailure" });
ok(!existsSync(sidecar), "a matching failure close deletes the sidecar");

const permission = { ...open, hook_event_name: "PermissionRequest" };
delete permission.tool_use_id;
const requested = run(permission);
const withoutId = JSON.parse(readFileSync(sidecar, "utf8"));
ok(requested.status === 0 && requested.stdout === "{}" && withoutId.tool_use_id === null,
   "PermissionRequest may open with a null tool id and returns no decision");
run({ ...open, hook_event_name: "PostToolUse", tool_use_id: "toolu_DIFFERENT" });
ok(!existsSync(sidecar), "any close clears a stored null id because one ask can be live");

run(open);
run(permission);
const afterPermission = JSON.parse(readFileSync(sidecar, "utf8"));
ok(afterPermission.tool_use_id === open.tool_use_id,
   "PermissionRequest preserves the non-null id written by PreToolUse");
ok(afterPermission.event === "PermissionRequest" && Number.isFinite(afterPermission.visible_ts),
   "PermissionRequest marks the existing ask visible without re-keying it");
const visibleContent = readFileSync(sidecar, "utf8");
const visibleMtime = statSync(sidecar).mtimeMs;
run(permission);
ok(readFileSync(sidecar, "utf8") === visibleContent && statSync(sidecar).mtimeMs === visibleMtime,
   "an identical repeated PermissionRequest does not rewrite the sidecar");

run(open);
run({ hook_event_name: "Stop", session_id: sid, cwd });
ok(!existsSync(sidecar), "Stop clears an ask when Claude omits its closing tool hook");

mkdirSync(dirname(sidecar), { recursive: true });
writeFileSync(sidecar, "not json");
const malformedClose = run({ ...open, hook_event_name: "PostToolUse" });
ok(malformedClose.status === 0 && malformedClose.stdout === "{}" && existsSync(sidecar),
   "malformed stored state fails open without returning a decision");

const badInput = spawnSync("node", [join(ROOT, "hooks/ask-sidecar.mjs")], {
  input: "not json",
  env: { ...drillEnv(), AGENT_BUS_DIR: bus, HOME: bus },
  encoding: "utf8",
});
ok(badInput.status === 0 && badInput.stdout === "{}", "malformed stdin fails open");

const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks;
const commands = event => (hooks[event] ?? []).flatMap(group => group.hooks.map(h => `${group.matcher}:${h.command}`));
for (const event of ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"]) {
  ok(commands(event).includes(`AskUserQuestion:node \${CLAUDE_PLUGIN_ROOT}/hooks/ask-sidecar.mjs`),
     `${event} registers the AskUserQuestion sidecar hook`);
}
ok(commands("Stop").includes(`:node \${CLAUDE_PLUGIN_ROOT}/hooks/ask-sidecar.mjs`),
   "Stop registers unconditional stale-open cleanup");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
