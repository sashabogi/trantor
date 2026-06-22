#!/usr/bin/env node
// trantor sub-agent manifest tests — derive a session's sub-agent activity purely from on-disk
// transcripts, and use the disk-reconcile to flag files an agent finished that were later
// clobbered (the 2026-06-21 kill corrupted a completed 30KB lib to a 17-byte stub). Hermetic:
// builds a synthetic ~/.claude/projects-style tree in a temp dir, no network, no real sessions.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveSubagentManifest, formatSubagentManifest, resolveTranscriptForSid } from "./lib/subagent-manifest.mjs";

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

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
