#!/usr/bin/env node
// trantor PostModelSwitch hook — Claude Code reports the session's new model (to_model). The
// heartbeat only learns it from the transcript tail, a minute and a turn late, so this tells the
// hub right away and the peer row (and anything pricing off it) carries the model that is running.
// Prints nothing: plain stdout on this event becomes model context. Fail-silent, exits 0.
import { homedir } from "node:os";
import { sessionContext, signedPost } from "./lib/api.mjs";
import { modelSwitchRegister } from "./lib/cc-signals.mjs";

setTimeout(() => process.exit(0), 4000).unref();   // watchdog: never hold up the switch

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 300);
  });
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Same rule as heartbeat.mjs: a bare home-directory session is not project work.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && cwd === homedir()) process.exit(0);
  const { session, project } = sessionContext(cwd);
  const llm = process.env.RELAY_LLM || (process.env.RELAY_AGENT ? process.env.RELAY_AGENT.replace(/-orch$/, "") : "claude");
  const body = modelSwitchRegister(input, { session, project, llm });
  if (body) {
    await signedPost("/register", body, { session, timeoutMs: 2500 });
    process.stderr.write(`[trantor] model switch ${input.from_model || "?"} -> ${body.model} (${input.source || "?"})\n`);
  }
} catch (e) {
  process.stderr.write(`[trantor] model-switch error: ${e?.message || e}\n`);
}
process.exit(0);
