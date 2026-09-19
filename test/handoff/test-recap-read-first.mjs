#!/usr/bin/env node
// A handoff's READ-FIRST list is checked, not merely stated (#8162).
//
// The operator, three days running: "the agent after the handoff just starts working, wastes about
// 20% of the context, and does not read the memory or the handoff completely at all."
//
// It was not disobedience. Neither kickoff prompt asked the successor to read anything — both asked
// it to RECAP — and the handoff summary is injected at SessionStart, so a competent 3-sentence recap
// is producible without opening a single file. The successor satisfied its instruction completely.
// Then the ledger certified it: RECAPPED was stamped because "by Stop time an assistant reply
// exists". A reply is the proxy; comprehension is the thing; we checked the proxy.
//
// crebral-health's own account, unprompted: "I have not read PRD.md at all ... I have not read the
// three memory files the handoff explicitly labelled read first ... I went straight to code."
//
// So the list is data now, and the evidence is a tool call — the same rule the state gate arrived at
// the hard way: ground truth, not testimony. A successor saying it read the handoff is not evidence.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFirstPaths, pathsReadIn } from "../../hooks/lib/handoff.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "recap-"));
/** A transcript carrying the given tool calls, in the shape Claude Code actually writes. */
const transcript = (calls) => {
  const p = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, calls.map(c =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: c.name, input: c.input }] } })).join("\n"));
  return p;
};

// The real shape: crebral-health's handoff, which named three memory files and got none of them read.
const SUMMARY = `# HANDOFF — Crebral Health

## TASK
Revenue integrity build.

## READ FIRST
- handoff-2026-09-10.md
- revenue-integrity-build.md
- exec-lane-fence-and-rls-ceiling.md

## OPEN THREADS
1. #8152 — exec overview in SQL. See docs/crew/revenue-integrity/TDD.md §4.
`;

console.log("\nthe list comes out of the handoff as DATA");
{
  const got = readFirstPaths(SUMMARY);
  ok("all three named files are extracted", got.length === 3, JSON.stringify(got));
  ok("…in the order the handoff gave them", got[0] === "handoff-2026-09-10.md", JSON.stringify(got));
  ok("a file mentioned OUTSIDE the section is not conscripted", !got.includes("docs/crew/revenue-integrity/TDD.md"), JSON.stringify(got));
  ok("a handoff with no read-first section asks for nothing", readFirstPaths("# H\n\n## TASK\nwork.\n").length === 0);
  ok("junk in, empty out — never a throw", readFirstPaths(null).length === 0 && readFirstPaths(undefined).length === 0);
}

console.log("\nthe evidence is a TOOL CALL, never the successor's say-so");
{
  const want = readFirstPaths(SUMMARY);

  // THE FAILURE THIS CARD EXISTS FOR: a successor that recapped beautifully and opened nothing.
  const none = transcript([{ name: "Bash", input: { command: "git status" } }]);
  const r1 = pathsReadIn(none, want);
  ok("a successor that opened nothing has missed all three", r1.missed.length === 3 && r1.read.length === 0, JSON.stringify(r1));

  // The proxy that used to pass: the paths ARE in the transcript — quoted in the injected summary
  // and in the model's own prose — but never opened. Text presence must not count as reading.
  const quoted = join(dir, "quoted.jsonl");
  writeFileSync(quoted, JSON.stringify({ type: "assistant", message: { content: [{ type: "text",
    text: `I have reviewed handoff-2026-09-10.md, revenue-integrity-build.md and exec-lane-fence-and-rls-ceiling.md.` }] } }));
  const r2 = pathsReadIn(quoted, want);
  ok("naming the files in prose is NOT reading them", r2.read.length === 0 && r2.missed.length === 3, JSON.stringify(r2));

  // Actually opening them, by absolute path, as a real Read call does.
  const opened = transcript(want.map(p => ({ name: "Read", input: { file_path: `/Users/x/.claude/projects/proj/memory/${p}` } })));
  const r3 = pathsReadIn(opened, want);
  ok("opening all three by absolute path satisfies the list", r3.missed.length === 0 && r3.read.length === 3, JSON.stringify(r3));

  // Partial is partial — the whole point is naming WHAT was skipped.
  const half = transcript([{ name: "Read", input: { file_path: `/m/handoff-2026-09-10.md` } }]);
  const r4 = pathsReadIn(half, want);
  ok("reading one of three names the other two as missed", r4.read.length === 1 && r4.missed.length === 2, JSON.stringify(r4));
  ok("…and names them specifically", r4.missed.includes("revenue-integrity-build.md"), JSON.stringify(r4.missed));

  // Grep counts: opening a file to search it is reading it.
  const grepped = transcript(want.map(p => ({ name: "Grep", input: { path: `/m/${p}` } })));
  ok("a Grep of the path counts as opened", pathsReadIn(grepped, want).missed.length === 0);

  // Degradation: a transcript that cannot be read must report everything missed, never everything read.
  const gone = pathsReadIn(join(dir, "does-not-exist.jsonl"), want);
  ok("an unreadable transcript fails CLOSED — all missed, never all read", gone.missed.length === 3 && gone.read.length === 0, JSON.stringify(gone));

  ok("an empty want-list is satisfied trivially", pathsReadIn(none, []).missed.length === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
