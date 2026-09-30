// Regression tests for the v0.17.37 sub-agent cost fix: the SubagentStop hook used to sum a PARENT
// session transcript onto recall/handoff sub-agent cards, inflating notional cost to tens of thousands
// of $. Guards: only accept a real sub-agent transcript path; skip implausibly large costs.
import { isSubagentTranscript, isImplausibleCost } from "../../hooks/lib/subagent-cost-lib.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

// --- isSubagentTranscript: accept only real sub-agent transcripts ---
ok(isSubagentTranscript("/u/.claude/projects/p/SID/subagents/agent-abc123.jsonl") === true, "accepts subagents/agent-*.jsonl");
ok(isSubagentTranscript("/u/.claude/projects/p/SID/subagents/workflows/wf1/agent-x.jsonl") === true, "accepts workflow sub-agent transcript");
ok(isSubagentTranscript("/u/.claude/projects/p/SID/79f6e443-a80b-47ed.jsonl") === false, "REJECTS the main session transcript (root <uuid>.jsonl) — the bug");
ok(isSubagentTranscript("/u/.claude/projects/p/SID/SID.jsonl") === false, "rejects session-root transcript");
ok(isSubagentTranscript("") === false, "rejects empty path");
ok(isSubagentTranscript("/tmp/agent-foo.jsonl") === false, "rejects agent-*.jsonl NOT under /subagents/");

// --- isImplausibleCost: skip parent-transcript-sized usage ---
ok(isImplausibleCost({ usd: 167, cacheRead: 237e6 }) === true, "flags the $167 / 237M cache-read recall card (the bug)");
ok(isImplausibleCost({ usd: 0.30, cacheRead: 0.5e6 }) === false, "passes a real recall agent ($0.30 / 0.5M)");
ok(isImplausibleCost({ usd: 27, cacheRead: 44e6 }) === false, "passes the biggest real build agent ($27 / 44M)");
ok(isImplausibleCost({ usd: null, cacheRead: 60e6 }) === true, "flags 60M cache-read even with null usd");
ok(isImplausibleCost({ usd: 80, cacheRead: 1e6 }) === true, "flags >$50 even with small cache-read");
ok(isImplausibleCost({}) === false, "empty → not implausible");

// --- #9707: the hook's stdout must carry no additionalContext; CC feeds it back to the sub-agent and loops it ---
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const home = mkdtempSync(join(tmpdir(), "tt-subcost-"));
  const tp = join(home, ".claude", "projects", "p", "SID", "subagents", "agent-loop1.jsonl");
  mkdirSync(dirname(tp), { recursive: true });
  writeFileSync(tp, [
    JSON.stringify({ type: "user", message: { role: "user", content: "do a small task" } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } }),
  ].join("\n") + "\n");
  const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "subagent-cost.mjs");
  const run = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ transcript_path: tp, cwd: home, agent_type: "general-purpose", agent_id: "loop1", session_id: "SID" }),
    env: { PATH: process.env.PATH, HOME: home, RELAY_URL: "http://127.0.0.1:9", TRANTOR_PROJECT: "tt-subcost" },
    encoding: "utf8", timeout: 20000,
  });
  const out = (run.stdout || "").trim();
  ok(run.status === 0, `hook exits 0 (status ${run.status})`);
  ok(!out.includes("additionalContext"), `SubagentStop output carries no additionalContext, so the sub-agent is not re-woken (got ${out.slice(0, 120)})`);
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
