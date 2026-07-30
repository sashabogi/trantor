#!/usr/bin/env node
// trantor file-claims tests — shared-resource awareness (2026-07-30).
//
// The feature: before every file edit, a session posts a claim; the hub answers with any LIVE
// claim on the same file by a DIFFERENT session, and the PreToolUse hook hands that to the acting
// session's model as context. Two sessions touching the same file learn about each other BEFORE
// the edit, not at git time.
//
// Kept honest here:
//   1. conflicts are cross-session only — re-claiming your own file is silent
//   2. claims expire by TTL (they describe NOW, like presence)
//   3. the FEED gets file.claim once per window and file.conflict on every collision
//   4. the REAL hook script, run as Claude Code runs it, injects the warning on a conflict and
//      stays silent (and fail-open) otherwise
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

function spawnHub(port, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-claims-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...process.env, RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "off", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor file-claims tests");

// ── hub semantics ────────────────────────────────────────────────────────────────────────────────
const PA = 47921, hubA = spawnHub(PA);
await sleep(800);
try {
  const A = mk(`http://127.0.0.1:${PA}`);

  const first = await A.post("/claim", { project: "p", file: "src/app.ts", session: "host:p" });
  ok(first.ok === true && first.conflicts.length === 0, "first claim: no conflicts");

  const again = await A.post("/claim", { project: "p", file: "src/app.ts", session: "host:p" });
  ok(again.conflicts.length === 0, "re-claiming your OWN file is silent");

  const other = await A.post("/claim", { project: "p", file: "src/app.ts", session: "codex:p" });
  ok(other.conflicts.length === 1 && other.conflicts[0].session === "host:p",
     "second session on the same file sees the conflict");

  const elsewhere = await A.post("/claim", { project: "p", file: "src/other.ts", session: "codex:p" });
  ok(elsewhere.conflicts.length === 0, "a different file conflicts with nobody");

  const otherProj = await A.post("/claim", { project: "q", file: "src/app.ts", session: "kimi:q" });
  ok(otherProj.conflicts.length === 0, "same path in a DIFFERENT project conflicts with nobody");

  const list = await A.get("/claims?project=p");
  ok((list.claims ?? []).length === 3, "/claims lists the project's live claims");

  const ev = await A.get("/events?project=p&type=file.");
  const types = (ev.events ?? []).map(e => e.type);
  ok(types.filter(t => t === "file.claim").length === 3, "file.claim once per (session,file), not per re-claim");
  ok(types.filter(t => t === "file.conflict").length === 1, "file.conflict on the collision");

  const hist = await A.get("/history?project=p");
  ok((hist.events ?? []).every(e => !String(e.type).startsWith("file.")), "dotted claim types never leak into /history");
} catch (e) { fail++; console.log(`  ✗ hub semantics: ${e.message}`); }
finally { hubA.kill(); }

// ── TTL ──────────────────────────────────────────────────────────────────────────────────────────
const PB = 47922, hubB = spawnHub(PB, { RELAY_CLAIM_TTL_MS: "300" });
await sleep(800);
try {
  const B = mk(`http://127.0.0.1:${PB}`);
  await B.post("/claim", { project: "p", file: "a.ts", session: "host:p" });
  await sleep(400);   // past the 300ms TTL
  const late = await B.post("/claim", { project: "p", file: "a.ts", session: "codex:p" });
  ok(late.conflicts.length === 0, "an EXPIRED claim no longer conflicts (TTL)");
  const list = await B.get("/claims?project=p");
  ok((list.claims ?? []).length === 1, "expired claims are pruned from /claims");
} catch (e) { fail++; console.log(`  ✗ TTL: ${e.message}`); }
finally { hubB.kill(); }

// ── the REAL hook, run the way Claude Code runs it ──────────────────────────────────────────────
const PC = 47923, hubC = spawnHub(PC);
await sleep(800);
try {
  const C = mk(`http://127.0.0.1:${PC}`);
  const work = mkdtempSync(join(tmpdir(), "trantor-claimhook-"));   // the "project" directory
  const busDir = mkdtempSync(join(tmpdir(), "trantor-claimbus-"));  // isolated keys/stamps

  const runHook = (session, file) => spawnSync("node", [join(ROOT, "hooks/file-claim.mjs")], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(work, file) }, cwd: work }),
    env: { ...process.env, RELAY_URL: `http://127.0.0.1:${PC}`, RELAY_SESSION: session, AGENT_BUS_DIR: busDir, HOME: busDir },
    encoding: "utf8", timeout: 10000,
  });

  const r1 = runHook("host:claimhook", "src/index.ts");
  ok(r1.status === 0 && r1.stdout.trim() === "{}", "hook: first touch is silent (no conflict)");

  const r2 = runHook("codex:claimhook", "src/index.ts");
  let out2 = {}; try { out2 = JSON.parse(r2.stdout); } catch {}
  const ctx = out2?.hookSpecificOutput?.additionalContext ?? "";
  ok(r2.status === 0 && ctx.includes("host:claimhook") && ctx.includes("src/index.ts"),
     "hook: second session gets the collision handed to its model");
  ok(out2?.hookSpecificOutput?.permissionDecision === "allow", "hook: informational, never blocking");

  const r3 = runHook("codex:claimhook", "src/index.ts");
  ok(r3.status === 0 && r3.stdout.trim() === "{}", "hook: re-claim throttled by the stamp window");

  const claims = await C.get(`/claims`);
  ok((claims.claims ?? []).some(c => c.session === "host:claimhook") &&
     (claims.claims ?? []).some(c => c.session === "codex:claimhook"),
     "hook: both sessions' claims landed on the hub, repo-relative");

  // hub unreachable -> fail open, instantly
  const dead = spawnSync("node", [join(ROOT, "hooks/file-claim.mjs")], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(work, "x.ts") }, cwd: work }),
    env: { ...process.env, RELAY_URL: "http://127.0.0.1:1", RELAY_SESSION: "host:claimhook", AGENT_BUS_DIR: busDir, HOME: busDir },
    encoding: "utf8", timeout: 10000,
  });
  ok(dead.status === 0 && dead.stdout.trim() === "{}", "hook: hub down -> allow, never trap the session");
} catch (e) { fail++; console.log(`  ✗ hook e2e: ${e.message}`); }
finally { hubC.kill(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
