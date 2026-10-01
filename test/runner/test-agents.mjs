#!/usr/bin/env node
// trantor sub-agent manifest tests — derive a session's sub-agent activity purely from on-disk
// transcripts, and use the disk-reconcile to flag files an agent finished that were later
// clobbered by a kill (a completed 30KB lib once survived only as a 17-byte stub). Hermetic:
// builds a synthetic ~/.claude/projects-style tree in a temp dir, no network, no real sessions.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveSubagentManifest, formatSubagentManifest, resolveTranscriptForSid } from "../../lib/subagent-manifest.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
console.log("# trantor sub-agent manifest tests");

const root = join(tmpdir(), "trantor-agents-" + process.pid);
const projDir = join(root, "myproj");                 // pretend repo root (path shortening + written files)
const encDir = join(root, "projects", "-enc-myproj"); // pretend ~/.claude/projects/<encoded>
const sid = "SID123";
const sub = join(encDir, sid, "subagents");
mkdirSync(sub, { recursive: true });
mkdirSync(join(projDir, "src"), { recursive: true });
const parent = join(encDir, sid + ".jsonl");

const J = (x) => JSON.stringify(x);
function agent(id, meta, turns) {
  writeFileSync(join(sub, `agent-${id}.meta.json`), J(meta));
  writeFileSync(join(sub, `agent-${id}.jsonl`), turns.map(J).join("\n") + "\n");
}
const write = (path, content, ts = "2026-06-21T20:00:00.000Z") =>
  ({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path, content } }] } });
const say = (text, ts) => ({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });

// On-disk reality: one intact file, one clobbered to a stub, one never created (missing).
const intactPath = join(projDir, "src", "intact.ts");
writeFileSync(intactPath, "x".repeat(8000));
const clobberedPath = join(projDir, "src", "clobbered.ts");
writeFileSync(clobberedPath, "stub");                  // agent wrote 9000B, disk has 4B → SUSPECT
const missingPath = join(projDir, "src", "gone.ts");   // agent wrote 5000B, file absent → SUSPECT

// A: completed, wrote the intact file.
agent("aaa", { agentType: "general-purpose", name: "alpha", description: "Build alpha", toolUseId: "tool_A" },
  [write(intactPath, "x".repeat(8000)), say("Alpha done.", "2026-06-21T20:01:00.000Z")]);
// B: completed, but its files were clobbered / lost on disk.
agent("bbb", { agentType: "general-purpose", name: "beta", description: "Build beta", toolUseId: "tool_B" },
  [write(clobberedPath, "y".repeat(9000)), write(missingPath, "z".repeat(5000))]);
// C: IN-FLIGHT — never returned a result to the parent.
agent("ccc", { agentType: "Explore", name: "gamma", description: "Explore gamma", toolUseId: "tool_C" },
  [{ type: "user", timestamp: "2026-06-21T20:02:00.000Z", message: { content: "go" } }]);
// W: a Workflow agent under workflows/<wf>/.
mkdirSync(join(sub, "workflows", "wf1"), { recursive: true });
writeFileSync(join(sub, "workflows", "wf1", "agent-wkf.meta.json"), J({ agentType: "general-purpose", name: "wflow", description: "WF step", toolUseId: "tool_W" }));
writeFileSync(join(sub, "workflows", "wf1", "agent-wkf.jsonl"), J(say("wf done", "2026-06-21T20:03:00.000Z")) + "\n");

// Parent transcript: tool_result for A, B, W (returned) — none for C (in-flight).
writeFileSync(parent, ["tool_A", "tool_B", "tool_W"]
  .map((id) => J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } })).join("\n") + "\n");

const m = deriveSubagentManifest(parent, { projectRoot: projDir });
const byName = Object.fromEntries(m.subagents.map((s) => [s.name, s]));

ok("counts: 4 total sub-agents (incl. the workflow agent)", m.counts.total === 4);
ok("counts: 3 completed (A,B,W returned a result)", m.counts.completed === 3);
ok("counts: 1 in-flight (C never returned)", m.counts.inFlight === 1);
ok("counts: 2 suspect files (clobbered + missing)", m.counts.suspectFiles === 2);
ok("status: completed agent detected via parent tool_result", byName.alpha?.status === "completed");
ok("status: in-flight agent detected (no tool_result)", byName.gamma?.status === "in-flight");
ok("files: intact file is NOT suspect", byName.alpha.wrote.some((w) => /intact\.ts$/.test(w.path) && !w.suspect));
ok("reconcile: clobbered file flagged SUSPECT (disk << written)", byName.beta.wrote.some((w) => /clobbered\.ts$/.test(w.path) && w.suspect));
ok("reconcile: missing file flagged SUSPECT (onDiskNow 0)", byName.beta.wrote.some((w) => /gone\.ts$/.test(w.path) && w.suspect && w.onDiskNow === 0));
ok("workflow: agent carries its workflow id", byName.wflow?.workflow === "wf1");
ok("display: paths shortened relative to projectRoot", byName.alpha.wrote[0].path === "src/intact.ts");
ok("result: final assistant text captured", byName.alpha.result === "Alpha done.");
ok("pointer: per-agent transcript path present", /agent-aaa\.jsonl$/.test(byName.alpha.transcript));

const text = formatSubagentManifest(m);
ok("format: surfaces the SUSPECT/CLOBBERED warning", /SUSPECT/.test(text) && /CLOBBERED/.test(text));
ok("format: surfaces the IN-FLIGHT badge", /IN-FLIGHT/.test(text));

ok("resolveTranscriptForSid: empty for an unknown sid", resolveTranscriptForSid("definitely-not-real-xyz") === "");
ok("safety: missing transcript → empty manifest, no throw", deriveSubagentManifest(join(root, "nope.jsonl")).counts.total === 0);

// ── #10007 — the stale guard: agents launched before the session process started (sinceMs) can
// never return, so liveness mode must not count them as in-flight.
const T0 = Date.parse("2026-06-21T20:02:00.000Z"); // C's (gamma's) launch
const mFresh = deriveSubagentManifest(parent, { projectRoot: projDir, sinceMs: T0 - 1 });
ok("stale guard: since before every launch → 1 in-flight (C)", mFresh.counts.inFlight === 1);
ok("stale guard: nothing is stale yet", mFresh.counts.stale === 0);

const mAfter = deriveSubagentManifest(parent, { projectRoot: projDir, sinceMs: T0 + 1 });
ok("stale guard: since past C's launch → C reads stale, 0 in-flight", mAfter.counts.inFlight === 0 && mAfter.counts.stale === 1);
ok("stale guard: completed agents stay completed under since", mAfter.counts.completed === 3);
ok("stale guard: per-agent launchMs exposed", byName.gamma.launchMs === T0);
ok("format: stale badge names the process boundary", /stale/.test(formatSubagentManifest(mAfter)));

// The gate shape itself: 2 launched, 1 done → exactly 1 in flight. The tree sits under
// root/.claude/projects so the CLI (which resolves sids via homedir()) finds it under HOME=root.
const encDir2 = join(root, ".claude", "projects", "-enc-two");
const sid2 = "SID2LAUNCH";
const sub2 = join(encDir2, sid2, "subagents");
mkdirSync(sub2, { recursive: true });
writeFileSync(join(sub2, "agent-d1.meta.json"), J({ agentType: "general-purpose", name: "done-one", toolUseId: "tool_D1" }));
writeFileSync(join(sub2, "agent-d1.jsonl"), J(say("D1 done.", "2026-06-21T21:00:00.000Z")) + "\n");
writeFileSync(join(sub2, "agent-f1.meta.json"), J({ agentType: "general-purpose", name: "live-one", toolUseId: "tool_F1" }));
writeFileSync(join(sub2, "agent-f1.jsonl"), J({ type: "user", timestamp: "2026-06-21T21:01:00.000Z", message: { content: "go" } }) + "\n");
writeFileSync(join(encDir2, sid2 + ".jsonl"), [
  J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_D1" }] } }),
].join("\n") + "\n");
const m2 = deriveSubagentManifest(join(encDir2, sid2 + ".jsonl"), { projectRoot: projDir });
ok("gate shape: 2 launched, 1 done, 1 in flight", m2.counts.total === 2 && m2.counts.completed === 1 && m2.counts.inFlight === 1);

// The CLI the desktop shells: `trantor agents <sid> --json --since <ms>` over the same rule.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliOut = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "bin", "agents.mjs"), sid2, "--json"],
  { cwd: repoRoot, env: { ...process.env, HOME: root, RELAY_DATA_DIR: root }, encoding: "utf8" }));
ok("cli: agents <sid> --json parses and counts the gate shape", cliOut.counts.total === 2 && cliOut.counts.inFlight === 1);
const cliSince = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "bin", "agents.mjs"), sid2, "--json",
  "--since", String(Date.parse("2026-06-21T21:01:30.000Z"))],
  { cwd: repoRoot, env: { ...process.env, HOME: root, RELAY_DATA_DIR: root }, encoding: "utf8" }));
ok("cli: --since marks the older launch stale → 0 in flight", cliSince.counts.inFlight === 0 && cliSince.counts.stale === 1);
// A future --since: both launches predate the process → both stale, nothing live.
const cliFuture = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "bin", "agents.mjs"), sid2, "--json", "--since", "99999999999999"],
  { cwd: repoRoot, env: { ...process.env, HOME: root, RELAY_DATA_DIR: root }, encoding: "utf8" }));
ok("cli: future --since → the live launch goes stale, 0 in flight, done stays done",
  cliFuture.counts.inFlight === 0 && cliFuture.counts.stale === 1 && cliFuture.counts.completed === 1);

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
