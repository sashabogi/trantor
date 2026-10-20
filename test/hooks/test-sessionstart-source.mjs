#!/usr/bin/env node
// #11853 — the session-start board catch-up is injected ONLY on a fresh start: a `claude -c`
// resume used to weld another 2-4K-token <trantor-project-state> dump into the transcript on
// every resume, so resume/compact now get a one-line relay_board pointer instead, while the
// fetch that sets sessionTitle still runs on every source (picker/--resume/mobile read it).
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };

const proj = "relay-source-test-" + process.pid;
const projDir = realpathSync(mkdirSync(join(tmpdir(), proj), { recursive: true }));
const CARD = "Resume-source probe card";
const hubDir = join(realpathSync(tmpdir()), `trantor-src-hub-${process.pid}`);
mkdirSync(hubDir, { recursive: true });
const hub = await startTestHub({ dir: hubDir, env: { RELAY_HOST: "127.0.0.1" } });

const runHook = (source) => spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: JSON.stringify({ source, session_id: `sess-${source || "empty"}`, cwd: projDir }),
  encoding: "utf8", timeout: 20000, cwd: process.cwd(),
  env: { ...drillEnv(), CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: `probe:${proj}`, RELAY_URL: hub.base,
    TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1" },
});
const parse = (r) => { try { return JSON.parse(r.stdout || "{}")?.hookSpecificOutput || {}; } catch { return {}; } };

console.log("# sessionstart source gating (#11853)");
try {
  const made = await fetch(`${hub.base}/task`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: proj, title: CARD, status: "doing", by: "test" }) }).then(r => r.json());
  ok("probe card created on the test hub", !!made?.task?.id);

  const startup = parse(runHook("startup"));
  const sCtx = startup.additionalContext || "";
  ok("startup injects the full <trantor-project-state> block", sCtx.includes("<trantor-project-state"));
  ok("startup block carries the live board content", sCtx.includes(CARD));
  ok("startup adds no pointer", !sCtx.includes("<trantor-board-pointer"));
  ok("startup sessionTitle names the in-flight card", String(startup.sessionTitle || "").includes(proj) && String(startup.sessionTitle || "").includes(CARD));

  for (const source of ["resume", "compact"]) {
    const out = parse(runHook(source));
    const ctx = out.additionalContext || "";
    ok(`${source} does NOT inject the <trantor-project-state> block`, !ctx.includes("<trantor-project-state"));
    ok(`${source} does not leak board content into context`, !ctx.includes(CARD) && !ctx.includes("Catching up on the continuous"));
    ok(`${source} gets the one-line relay_board pointer`, ctx.includes("<trantor-board-pointer") && ctx.includes("relay_board"));
    ok(`${source} still computes sessionTitle from the live board (fetch ran)`,
      String(out.sessionTitle || "").includes(proj) && String(out.sessionTitle || "").includes(CARD));
  }

  const cleared = parse(runHook("clear"));
  ok("clear (an emptied context) gets the full block", (cleared.additionalContext || "").includes("<trantor-project-state"));

  const unknown = parse(runHook(""));
  ok("empty/unknown source fails OPEN to the full block", (unknown.additionalContext || "").includes("<trantor-project-state"));

  // #12094: a resume carrying CC's staleness fields gets ONE staleness line; without them, none.
  const stale = { seconds_since_last_response: 5400, context_tokens: 182340, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396 };
  const runWith = (source, extra) => spawnSync("node", ["hooks/sessionstart.mjs"], {
    input: JSON.stringify({ source, session_id: `sess-stale-${source}`, cwd: projDir, ...extra }),
    encoding: "utf8", timeout: 20000, cwd: process.cwd(),
    env: { ...drillEnv(), CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: `probe:${proj}`, RELAY_URL: hub.base,
      TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1" },
  });
  const staleRun = runWith("resume", stale);
  const staleCtx = parse(staleRun).additionalContext || "";
  const tag = staleCtx.match(/<trantor-resume-staleness>([^<]*)<\/trantor-resume-staleness>/);
  ok("resume with staleness fields injects the staleness line", !!tag && tag[1].includes("1.5h") && tag[1].includes("$1.14") && !tag[1].includes("\n"), staleCtx.slice(0, 200));
  ok("the staleness line also reaches stderr", staleRun.stderr.includes("1.5h stale"));
  ok("resume without the fields injects no staleness line", !(parse(runWith("resume", {})).additionalContext || "").includes("trantor-resume-staleness"));
  ok("startup ignores the fields", !(parse(runWith("startup", stale)).additionalContext || "").includes("trantor-resume-staleness"));
} finally {
  await hub.stop();
  try { rmSync(hubDir, { recursive: true, force: true }); } catch {}
  try { rmSync(projDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
