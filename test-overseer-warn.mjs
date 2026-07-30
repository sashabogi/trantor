#!/usr/bin/env node
// trantor overseer-warn hook tests — the SessionStart half of the overseer (2026-07-30).
//
// The feature: at session start, the hook asks the hub for GET /overseer/context?project=<p> and,
// at autonomy level >= 2 with something to say (warnings / in-flight claims / declared links),
// hands the session's model a plain-language paragraph: linked projects, who is live (llm·model),
// which files are in flight. Detection stays mechanical in the hub; this hook only narrates.
//
// Kept honest here (docs/OVERSEER-CONTRACT.md, kimi row):
//   1. level >= 2 + warnings/inflight/links -> SessionStart additionalContext injection
//   2. level 1 (observe) -> silence, even with warnings present
//   3. level >= 2 with NOTHING to say -> silence (no noise)
//   4. the paragraph cites sessions/files/projects and stays <= 900 chars, however big the payload
//   5. hub down / malformed payload -> {} and exit 0 (fail-open is a contract)
//
// The hub side of the overseer lands in parallel, so these tests run the REAL hook against a stub
// HTTP server serving a canned /overseer/context — the same way test-claims.mjs runs file-claim.mjs.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

console.log("# trantor overseer-warn hook tests");

// ── stub hub: one server, switchable canned payload ─────────────────────────────────────────────
let canned = null;                 // null -> 404; string -> served raw (malformed-JSON test)
const server = createServer((req, res) => {
  if (req.url.startsWith("/overseer/context") && canned) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof canned === "string" ? canned : JSON.stringify(canned));
  } else {
    res.writeHead(404).end("{}");
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const work = mkdtempSync(join(tmpdir(), "trantor-owarn-"));
const busDir = mkdtempSync(join(tmpdir(), "trantor-owarnbus-"));
// ASYNC on purpose: the stub server above lives in THIS process, so the hook must run via
// async spawn — a spawnSync here blocks the event loop, the stub can never answer, and every
// "emits" case fails open to {} (exactly how the first version of this file deadlocked itself).
const runHook = (relayUrl, input = JSON.stringify({ hook_event_name: "SessionStart", cwd: work })) =>
  new Promise((resolve) => {
    const c = spawn("node", [join(ROOT, "hooks/overseer-warn.mjs")], {
      env: { ...process.env, RELAY_URL: relayUrl, RELAY_SESSION: "kimi:owarn", RELAY_PROJECT: "owarn", AGENT_BUS_DIR: busDir, HOME: busDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", d => { stdout += d; });
    c.stderr.on("data", d => { stderr += d; });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, 10000);
    c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    c.stdin.end(input);
  });
const contextOf = (r) => {
  let out = {}; try { out = JSON.parse(r.stdout); } catch {}
  return { out, ctx: out?.hookSpecificOutput?.additionalContext ?? "" };
};

// ── 1. level 2 with links + peers + inflight + warnings -> injection ────────────────────────────
canned = {
  level: 2,
  links: [{ projects: ["owarn", "sister"], reason: "shared schema package" }],
  peers: [
    { session: "codex:owarn", llm: "openai", model: "gpt-5-codex", status: "working" },
    { session: "kimi:owarn", llm: "moonshot", model: "k2", status: "idle" },
  ],
  inflight: [{ file: "src/schema.ts", session: "codex:owarn", agoSec: 42 }],
  warnings: [{
    project: "owarn", kind: "file-conflict", sessions: ["kimi:owarn", "codex:owarn"],
    files: ["src/schema.ts"],
    detail: "kimi:owarn and codex:owarn both claimed src/schema.ts within 10m",
  }],
};
{
  const r = await runHook(BASE);
  const { out, ctx } = contextOf(r);
  ok(r.status === 0 && out?.hookSpecificOutput?.hookEventName === "SessionStart",
     "level 2 + context: emits a SessionStart hookSpecificOutput");
  ok(ctx.includes("sister") && ctx.includes("shared schema package"), "paragraph cites the linked project and why");
  ok(ctx.includes("codex:owarn") && ctx.includes("openai·gpt-5-codex"), "paragraph cites who is live (llm·model)");
  ok(ctx.includes("src/schema.ts"), "paragraph cites the file in flight");
  ok(ctx.includes("file-conflict") || ctx.includes("both claimed"), "paragraph carries the warning detail");
  ok(ctx.length <= 920, "paragraph respects the 900-char cap (plus prefix)");
}

// ── 2. level 1 (observe) -> silence, even with warnings ─────────────────────────────────────────
canned = { ...canned, level: 1 };
{
  const r = await runHook(BASE);
  ok(r.status === 0 && r.stdout.trim() === "{}", "level 1 observe: silence even with warnings present");
}

// ── 3. level >= 2 with nothing to say -> silence ────────────────────────────────────────────────
canned = { level: 3, links: [], peers: [], inflight: [], warnings: [] };
{
  const r = await runHook(BASE);
  ok(r.status === 0 && r.stdout.trim() === "{}", "level 3 but nothing to say: silence (no noise)");
}

// ── 4. the cap holds against a huge payload ──────────────────────────────────────────────────────
canned = {
  level: 2,
  links: Array.from({ length: 12 }, (_, i) => ({ projects: [`p${i}a`, `p${i}b`], reason: "x".repeat(120) })),
  peers: Array.from({ length: 20 }, (_, i) => ({ session: `agent-${i}:owarn`, llm: "llm", model: "model", status: "working" })),
  inflight: Array.from({ length: 20 }, (_, i) => ({ file: `src/file-${i}.ts`, session: `agent-${i}:owarn`, agoSec: i * 60 })),
  warnings: [],
};
{
  const r = await runHook(BASE);
  const { out, ctx } = contextOf(r);
  ok(r.status === 0 && out?.hookSpecificOutput?.hookEventName === "SessionStart", "huge payload: still emits");
  ok(ctx.length <= 920, "huge payload: paragraph truncated to the 900-char cap");
}

// ── 5. fail-open: hub down, malformed JSON, missing cwd ─────────────────────────────────────────
canned = null;
{
  const dead = await runHook("http://127.0.0.1:1");
  ok(dead.status === 0 && dead.stdout.trim() === "{}", "hub down: {} and exit 0, instantly (never traps the session)");
}
canned = "this is not json{";
{
  const r = await runHook(BASE);
  ok(r.status === 0 && r.stdout.trim() === "{}", "malformed hub payload: {} and exit 0");
}
canned = { level: 2, warnings: [{ kind: "same-project-sessions", detail: "two live sessions" }] };
{
  const r = await runHook(BASE, "not json at all");
  ok(r.status === 0 && (r.stdout.trim() === "{}" || r.stdout.includes("hookSpecificOutput")),
     "garbage stdin: still exits 0 with valid JSON");
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
