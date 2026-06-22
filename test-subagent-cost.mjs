// Regression tests for the v0.17.37 sub-agent cost fix: the SubagentStop hook used to sum a PARENT
// session transcript onto recall/handoff sub-agent cards, inflating notional cost to tens of thousands
// of $. Guards: only accept a real sub-agent transcript path; skip implausibly large costs.
import { isSubagentTranscript, isImplausibleCost } from "./hooks/lib/subagent-cost-lib.mjs";

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

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
