#!/usr/bin/env node
// Regression drill for #6270: an orchestrator identity (a session started via `trantor open`,
// or any Claude session not spawned by bin/crew-runner.mjs) never went through lib/enroll.mjs's
// owner-invite path. On an enforce hub that left it registered-looking but unknown to the hub —
// every read 401s silently, because hooks/lib/api.mjs's OWN ensureEnrolled POSTs /enroll with no
// invite token, which a non-loopback enforce hub refuses. hooks/sessionstart.mjs must now self-enrol
// via lib/enroll.mjs BEFORE its first hub call, exactly like a crew seat does, and say why when it
// can't.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreate } from "./lib/identity.mjs";
import { ensureEnrolled } from "./lib/enroll.mjs";
import { drillEnv } from "./drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  cond ? pass++ : fail++;
};

// spawnSync would block THIS process's event loop, starving the in-process http stub below of the
// very requests the child is trying to make — spawn + wait for "close" instead (test-cursor-rewind's
// pattern for exactly this reason).
function runHook(env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn("node", ["hooks/sessionstart.mjs"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.write('{"source":"startup"}');
    child.stdin.end();
  });
}

console.log("# #6270 orchestrator self-enrolment");

// ── unit: lib/enroll.mjs ensureEnrolled against a hand-rolled enforce stub ─────────────────────
{
  const scratch = mkdtempSync(join(tmpdir(), "trantor-enroll-unit-"));
  const busDirPath = join(scratch, "bus");
  process.env.AGENT_BUS_DIR = busDirPath;
  try {
    const owner = loadOrCreate("owner:enroll-unit", "agent");
    const seat = loadOrCreate("claude:enroll-unit-proj", "agent");   // key exists, never enrolled — no marker anywhere

    let peerCalls = 0, inviteCalls = 0, enrollCalls = 0;
    const enrolled = new Set();
    const stub = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const url = new URL(req.url, "http://x");
        const pk = req.headers["x-trantor-pubkey"] || "";
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (url.pathname === "/peer") { peerCalls++; return enrolled.has(pk) ? send(200, { ok: true }) : send(401, { error: "unknown identity" }); }
        if (url.pathname === "/invite" && req.method === "POST") { inviteCalls++; return send(200, { token: "test-invite-token" }); }
        if (url.pathname === "/enroll" && req.method === "POST") {
          enrollCalls++;
          let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
          if (parsed.token !== "test-invite-token") return send(400, { error: "bad token" });
          enrolled.add(pk);
          return send(200, { ok: true });
        }
        send(404, { error: "unhandled " + url.pathname });
      });
    });
    await new Promise(res => stub.listen(0, "127.0.0.1", res));
    const hub = `http://127.0.0.1:${stub.address().port}`;

    process.env.RELAY_OWNER_IDENTITY = "owner:enroll-unit";
    const before = await ensureEnrolled(hub, seat, "enroll-unit-proj");
    ok("first call: not-yet-enrolled seat gets enrolled", before.ok === true && before.reason === "enrolled", JSON.stringify(before));
    ok("exactly one /invite round trip", inviteCalls === 1, String(inviteCalls));
    ok("exactly one /enroll round trip", enrollCalls === 1, String(enrollCalls));
    ok("the probe hit /peer first", peerCalls >= 1, String(peerCalls));

    // a subsequent probe against the now-enrolled identity is a 200 read, no second invite/enroll
    const after = await ensureEnrolled(hub, seat, "enroll-unit-proj");
    ok("second call: already-enrolled short-circuits", after.ok === true && after.reason === "already-enrolled", JSON.stringify(after));
    ok("no repeat /invite on the already-enrolled path", inviteCalls === 1, String(inviteCalls));
    ok("no repeat /enroll on the already-enrolled path", enrollCalls === 1, String(enrollCalls));

    // no owner key configured → fails with a named reason, never silently
    delete process.env.RELAY_OWNER_IDENTITY;
    const otherSeat = loadOrCreate("claude:enroll-unit-proj2", "agent");
    const noOwner = await ensureEnrolled(hub, otherSeat, "enroll-unit-proj2");
    ok("no owner key → explicit reason, not a silent pass", noOwner.ok === false && noOwner.reason === "no-owner-key", JSON.stringify(noOwner));

    await new Promise(res => stub.close(res));
  } finally {
    delete process.env.AGENT_BUS_DIR;
    delete process.env.RELAY_OWNER_IDENTITY;
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── end-to-end: hooks/sessionstart.mjs actually walks this path on a real start ────────────────
{
  const scratch = mkdtempSync(join(tmpdir(), "trantor-enroll-e2e-"));
  const busDirPath = join(scratch, "bus");
  const projDir = join(scratch, "proj");
  mkdirSync(projDir, { recursive: true });
  try {
    process.env.AGENT_BUS_DIR = busDirPath;
    const owner = loadOrCreate("owner:enroll-e2e", "agent");
    delete process.env.AGENT_BUS_DIR;

    let inviteCalls = 0, enrollCalls = 0, registerCalls = 0;
    const enrolled = new Set();
    const stub = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const url = new URL(req.url, "http://x");
        const pk = req.headers["x-trantor-pubkey"] || "";
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (url.pathname === "/peer") return enrolled.has(pk) ? send(200, { ok: true }) : send(401, { error: "unknown identity" });
        if (url.pathname === "/invite" && req.method === "POST") { inviteCalls++; return send(200, { token: "e2e-token" }); }
        if (url.pathname === "/enroll" && req.method === "POST") {
          let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
          // hooks/lib/api.mjs's OWN (unrelated, pre-existing) ensureEnrolled also fires on every
          // signed call and POSTs /enroll with NO invite token — that is the exact silent-401 bug
          // this card fixes elsewhere, not something this test re-litigates. Only count the
          // owner-invite round trip (the token this stub minted via /invite) as a real enrolment.
          if (parsed.token !== "e2e-token") return send(400, { error: "bad token" });
          enrollCalls++;
          enrolled.add(pk);
          return send(200, { ok: true });
        }
        if (url.pathname === "/register" && req.method === "POST") { registerCalls++; return enrolled.has(pk) ? send(200, { ok: true }) : send(401, { error: "unknown identity" }); }
        if (url.pathname === "/peers") return enrolled.has(pk) ? send(200, { peers: [] }) : send(401, { error: "unknown identity" });
        send(200, { ok: true });   // everything else (lessons, catchup, ...) — best-effort, never blocks
      });
    });
    await new Promise(res => stub.listen(0, "127.0.0.1", res));
    const hub = `http://127.0.0.1:${stub.address().port}`;

    const env = drillEnv({
      AGENT_BUS_DIR: busDirPath,
      CLAUDE_PROJECT_DIR: projDir,
      RELAY_SESSION: "claude:enroll-e2e-proj",
      RELAY_PROJECT: "enroll-e2e-proj",
      RELAY_URL: hub,
      RELAY_OWNER_IDENTITY: "owner:enroll-e2e",
      TRANTOR_NO_UPDATE_CHECK: "1",
      TRANTOR_NO_UPDATE_NOTIFY: "1",
      TRANTOR_NO_BALANCE_CHECK: "1",
    });
    const r = await runHook(env);
    ok("hook exits 0", r.status === 0, r.stderr.slice(-300));
    ok("self-enrolled before /register: one /invite", inviteCalls === 1, String(inviteCalls));
    ok("self-enrolled before /register: one /enroll", enrollCalls === 1, String(enrollCalls));
    ok("register then succeeds (200, not 401)", registerCalls === 1, String(registerCalls));
    ok("no not-enrolled warning reached the user", !/not enrolled on/.test(r.stderr), r.stderr.slice(-300));

    let parsed = null; try { parsed = JSON.parse(r.stdout); } catch {}
    const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
    ok("no <trantor-not-enrolled> block once enrolment succeeds", !ctx.includes("trantor-not-enrolled"), ctx.slice(0, 300));

    await new Promise(res => stub.close(res));

    // ── failure path: hub answers 401 to /peer AND refuses /invite → reason surfaced, never silent
    let invite2 = 0;
    const stub2 = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/peer") return send(401, { error: "unknown identity" });
      if (url.pathname === "/invite") { invite2++; return send(403, { error: "not an owner" }); }
      send(200, { ok: true });
    });
    await new Promise(res => stub2.listen(0, "127.0.0.1", res));
    const hub2 = `http://127.0.0.1:${stub2.address().port}`;
    const env2 = drillEnv({
      AGENT_BUS_DIR: busDirPath,
      CLAUDE_PROJECT_DIR: projDir,
      RELAY_SESSION: "claude:enroll-e2e-proj",
      RELAY_PROJECT: "enroll-e2e-proj",
      RELAY_URL: hub2,
      RELAY_OWNER_IDENTITY: "owner:enroll-e2e",
      TRANTOR_NO_UPDATE_CHECK: "1",
      TRANTOR_NO_UPDATE_NOTIFY: "1",
      TRANTOR_NO_BALANCE_CHECK: "1",
    });
    const r2 = await runHook(env2);
    ok("hook still exits 0 on enrolment failure (fail-open)", r2.status === 0, r2.stderr.slice(-300));
    ok("invite refusal reported by reason, not silently swallowed", /not enrolled on .* \(invite-403\)/.test(r2.stderr), r2.stderr.slice(-300));
    let parsed2 = null; try { parsed2 = JSON.parse(r2.stdout); } catch {}
    const ctx2 = parsed2?.hookSpecificOutput?.additionalContext || "";
    ok("model context also names the failure reason (never silent)", ctx2.includes("trantor-not-enrolled") && ctx2.includes("invite-403"), ctx2.slice(0, 400));
    await new Promise(res => stub2.close(res));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
