#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "trantor-kimi-bridge-"));
const REAL_HOME = realpathSync(HOME);
const BUS = join(HOME, ".agent-bus");
let pass = 0, fail = 0;
let relHookPath = "";

const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

function run(event, hook, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [join(ROOT, "kimi", "bridge.mjs"), event, hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 8000,
    env: {
      ...process.env,
      HOME,
      AGENT_BUS_DIR: BUS,
      RELAY_DATA_DIR: BUS,
      KIMI_BRIDGE_CHILD_TIMEOUT_MS: "600",
      ...extraEnv,
    },
  });
}

function hook(name, body) {
  const p = join(HOME, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  return p;
}

console.log("# kimi bridge tests");
try {
  const capture = hook("capture.mjs", `
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  const input = JSON.parse(raw || "{}");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: JSON.stringify({
      hook_event_name: input.hook_event_name,
      prompt: input.prompt,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      cwd: process.cwd(),
    }) }
  }));
});
`);

  const payload = {
    hook_event_name: "k_user_prompt_submit",
    session_id: "kimi/session:1",
    cwd: HOME,
    user_prompt: [{ type: "text", text: "from alias" }, { type: "text", text: "second" }],
    toolName: "Write",
    input: { file_path: "/tmp/x" },
  };
  const r1 = run("UserPromptSubmit", capture, payload);
  const normalized = JSON.parse(r1.stdout);
  ok("UserPromptSubmit exits 0", r1.status === 0, r1.stderr);
  ok("event name normalized", normalized.hook_event_name === "UserPromptSubmit", r1.stdout);
  ok("prompt aliases normalize to prompt string", normalized.prompt === "from alias\nsecond", r1.stdout);
  ok("tool aliases normalize", normalized.tool_name === "Write" && normalized.tool_input?.file_path === "/tmp/x", r1.stdout);
  ok("canonical hook cwd comes from payload.cwd", normalized.cwd === REAL_HOME, normalized.cwd);

  const rTodo = run("PostToolUse", capture, { session_id: "todo", cwd: HOME, toolName: "TodoList", input: { todos: [{ content: "ship", status: "pending" }] } });
  const todoNormalized = JSON.parse(rTodo.stdout);
  ok("TodoList tool alias normalizes to TodoWrite", todoNormalized.tool_name === "TodoWrite", rTodo.stdout);

  relHookPath = join(ROOT, "kimi", `.bridge-rel-${process.pid}.mjs`);
  writeFileSync(relHookPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "relative ok" } }));
});
`);
  const rRel = run("PostToolUse", `./.bridge-rel-${process.pid}.mjs`, { session_id: "rel", cwd: HOME });
  ok("relative hook path resolves beside bridge, not payload cwd", rRel.status === 0 && rRel.stdout === "relative ok", `status=${rRel.status} stdout=${rRel.stdout} stderr=${rRel.stderr}`);

  // #4785 review: the manifest must pass hook paths RELATIVE (never $PWD — that expands to the
  // SESSION cwd at runtime and 404s from any project dir); the bridge resolves them against its
  // own file location. Assert every manifest hook arg resolves to an existing canonical hook.
  {
    const manifest = JSON.parse(readFileSync(join(ROOT, "kimi.plugin.json"), "utf8"));
    const bridgeURL = new URL(`file://${join(ROOT, "kimi", "bridge.mjs")}`);
    let bad = [];
    for (const h of manifest.hooks || []) {
      ok(`manifest ${h.event} carries no $PWD`, !String(h.command).includes("$PWD"), h.command);
      const arg = String(h.command).trim().split(/\s+/).pop();
      const resolved = fileURLToPath(new URL(arg, bridgeURL));
      if (!existsSync(resolved) || !resolved.startsWith(join(ROOT, "hooks"))) bad.push(`${h.event}:${arg}`);
    }
    ok("every manifest hook arg resolves to a canonical hooks/ file", bad.length === 0, bad.join(", "));
  }

  const stashHook = hook("stash.mjs", `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "startup ctx" } }));
});
`);
  const sess = "kimi/session:stash";
  const r2 = run("SessionStart", stashHook, { session_id: sess, cwd: HOME });
  const stashFile = join(BUS, "kimi-stash-kimi_session_stash.txt");
  ok("SessionStart suppresses stdout", r2.status === 0 && r2.stdout === "", r2.stdout);
  ok("SessionStart stashes additionalContext", readFileSync(stashFile, "utf8") === "startup ctx");

  const promptHook = hook("prompt.mjs", `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "prompt ctx" } }));
});
`);
  const r3 = run("UserPromptSubmit", promptHook, { session_id: sess, cwd: HOME, prompt: "go build" });
  ok("UserPromptSubmit flushes stash before hook context", r3.stdout === "startup ctx\nprompt ctx", JSON.stringify(r3.stdout));
  ok("UserPromptSubmit clears stash file", !existsSync(stashFile));

  const postHook = hook("post.mjs", `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "post ctx" } }));
});
`);
  const r4 = run("PostToolUse", postHook, { session_id: "post", cwd: HOME });
  ok("PostToolUse prints plain context", r4.status === 0 && r4.stdout === "post ctx", JSON.stringify(r4.stdout));

  const blockHook = hook("block.mjs", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ decision: "block", reason: "stop here" })));
`);
  const r5 = run("Stop", blockHook, { session_id: "block", cwd: HOME });
  ok("block decision maps to exit 2", r5.status === 2 && /stop here/.test(r5.stderr), `status=${r5.status} stderr=${r5.stderr}`);

  const continueFalseHook = hook("continue-false.mjs", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ continue: false, reason: "nope" })));
`);
  const r6 = run("PreToolUse", continueFalseHook, { session_id: "cf", cwd: HOME });
  ok("continue:false maps to exit 2", r6.status === 2 && /nope/.test(r6.stderr), `status=${r6.status} stderr=${r6.stderr}`);

  const badHook = hook("bad.mjs", `throw new Error("boom");`);
  const r7 = run("PostToolUse", badHook, { session_id: "bad", cwd: HOME });
  ok("canonical child failure fails open", r7.status === 0 && r7.stdout === "" && /fail-open/.test(r7.stderr), `status=${r7.status} stderr=${r7.stderr}`);

  const slowHook = hook("slow.mjs", `setTimeout(() => process.stdout.write("{}"), 5000);`);
  const r8 = run("PostToolUse", slowHook, { session_id: "slow", cwd: HOME });
  ok("child timeout fails open", r8.status === 0 && /timed out/.test(r8.stderr), `status=${r8.status} stderr=${r8.stderr}`);

  const debugHook = hook("debug.mjs", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"));`);
  const r9 = run("UserPromptSubmit", debugHook, { session_id: "dbg", cwd: HOME, text: "debug me" }, { TRANTOR_DEBUG_HOOKS: "1" });
  const debugLog = readFileSync(join(BUS, "kimi-hook-debug.jsonl"), "utf8");
  ok("debug hook captures raw payload", r9.status === 0 && debugLog.includes('"text":"debug me"'), debugLog);
} catch (e) {
  fail++;
  console.log(`  ✗ threw: ${e.message}`);
} finally {
  if (relHookPath) { try { rmSync(relHookPath, { force: true }); } catch {} }
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
