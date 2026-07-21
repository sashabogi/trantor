#!/usr/bin/env node
// trantor reconcile tests (2026-07-20) — the INTELLIGENT board-cleanup layer.
//
// The mechanical reaper only knows "owner offline → stale". reconcile reads the stuck cards + git + memory
// and asks a CHEAP model (Scrooge) whether each is DONE (already shipped → close), STALE (abandoned), or
// ACTIVE (leave). These tests stub the Scrooge judge (SCROOGE_BIN) so they're hermetic, and assert the
// candidate selection + verdict application against a real spawned hub.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJ = "reconproj";

function spawnHub(port) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-recon-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...process.env, RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_REAP_INTERVAL_MS: "999999" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}
console.log("# trantor reconcile tests");
const PORT = 47881, base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const cardStatus = async (id) => ((await get(`/tasks?project=${PROJ}`)).tasks.find(t => t.id === id) || {}).status;

// run bin/reconcile.mjs with a STUBBED scrooge that emits fixed verdicts
function reconcile(stubVerdicts, extraArgs = []) {
  const sdir = mkdtempSync(join(tmpdir(), "recon-scrooge-"));
  const stub = join(sdir, "scrooge");
  writeFileSync(stub, `#!/bin/bash\ncat >/dev/null\ncat <<'JSON'\n${JSON.stringify(stubVerdicts)}\nJSON\n`);
  chmodSync(stub, 0o755);
  return new Promise((res) => {
    const p = spawn("node", [join(ROOT, "bin/reconcile.mjs"), ...extraArgs], {
      cwd: sdir,   // non-git temp dir → empty gitlog/memory; the stub ignores them anyway
      env: { ...process.env, RELAY_URL: base, RELAY_PROJECT: PROJ, SCROOGE_BIN: stub },
      encoding: "utf8",
    });
    let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    p.on("close", () => { try { rmSync(sdir, { recursive: true, force: true }); } catch {} res(out); });
  });
}

const hub = spawnHub(PORT);
let herr = ""; hub.stderr.on("data", d => herr += d);
await sleep(800);
try {
  // seed: 3 real work cards + an ephemeral cc-subagent card + a session focus card (both must be ignored)
  const c1 = (await post("/task", { project: PROJ, title: "implement the stale-card reaper", status: "doing", assignee: "codex:reconproj", by: "codex:reconproj" })).task.id;
  const c2 = (await post("/task", { project: PROJ, title: "old abandoned spike nobody finished", status: "testing", assignee: "glm:reconproj", by: "glm:reconproj" })).task.id;
  const c3 = (await post("/task", { project: PROJ, title: "feature still genuinely pending", status: "todo", assignee: "host:reconproj", by: "host:reconproj" })).task.id;
  const cSub = (await post("/task", { project: PROJ, title: "subagent: transient infra card", status: "doing", source: "cc-subagent", agentId: "aid1", by: "host:reconproj" })).task.id;
  await post("/focus", { session: "host:reconproj", project: PROJ, title: "the session focus card", by: "host:reconproj" });

  const verdicts = [
    { id: c1, verdict: "done", reason: "shipped in commit abc123", commit: "abc123" },
    { id: c2, verdict: "stale", reason: "superseded, never finished", commit: "" },
    { id: c3, verdict: "active", reason: "still needed", commit: "" },
  ];

  // 1. PREVIEW (no --yes) changes nothing
  let out = await reconcile(verdicts, ["--older", "0"]);
  ok("preview shows a DONE verdict", /DONE — already shipped/.test(out) && out.includes("abc123"));
  ok("preview shows a STALE verdict", /STALE — abandoned/.test(out));
  ok("preview shows an ACTIVE verdict", /ACTIVE — still relevant/.test(out));
  ok("preview changes nothing (c1 still doing)", (await cardStatus(c1)) === "doing");
  ok("preview changes nothing (c2 still testing)", (await cardStatus(c2)) === "testing");

  // 2. APPLY (--yes)
  out = await reconcile(verdicts, ["--older", "0", "--yes"]);
  ok("apply closes the DONE card", (await cardStatus(c1)) === "done", `(got ${await cardStatus(c1)})`);
  ok("apply stales the STALE card", (await cardStatus(c2)) === "stale", `(got ${await cardStatus(c2)})`);
  ok("apply leaves the ACTIVE card as todo", (await cardStatus(c3)) === "todo", `(got ${await cardStatus(c3)})`);
  ok("apply reports the counts", /1 closed as done, 1 moved to stale/.test(out), `\n${out}`);

  // 3. ephemeral cc-subagent + session focus cards are NEVER candidates
  ok("cc-subagent card untouched (not a reconcile candidate)", (await cardStatus(cSub)) === "doing");
  const focus = (await get(`/tasks?project=${PROJ}`)).tasks.find(t => t.source === "session");
  ok("session focus card untouched", focus && focus.status === "doing");

  // 4. age filter: with --older 1h, freshly-touched cards are NOT candidates
  out = await reconcile(verdicts, ["--older", "1h"]);
  ok("nothing stuck when cards are fresher than --older", /nothing stuck to reconcile/.test(out), `\n${out}`);

  // 5. scrooge missing → safe no-op (doesn't fabricate verdicts)
  const p = await new Promise((res) => {
    const cp = spawn("node", [join(ROOT, "bin/reconcile.mjs"), "--older", "0"], {
      cwd: hub._dir, env: { ...process.env, RELAY_URL: base, RELAY_PROJECT: PROJ, SCROOGE_BIN: "/nonexistent/scrooge" },
    });
    let o = ""; cp.stdout.on("data", d => o += d); cp.stderr.on("data", d => o += d); cp.on("close", () => res(o));
  });
  ok("missing scrooge → leaves the board untouched", /leaving the board untouched/i.test(p) && (await cardStatus(c3)) === "todo");
} catch (e) {
  fail++; console.log("  ✗ threw:", e?.message || e, herr ? `\n  hub stderr: ${herr}` : "");
} finally {
  hub.kill(); try { rmSync(hub._dir, { recursive: true, force: true }); } catch {}
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
