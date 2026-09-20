#!/usr/bin/env node
// A handoff's READ-FIRST list is checked, not merely stated (#8162): a recap is producible from the
// injected summary alone, so a reply was never evidence a successor opened anything. The list is
// data and the evidence is a tool call — ground truth, not testimony. #8232: a lazy summary must
// not be able to disarm the gate either.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFirstPaths, pathsReadIn, writeHandoff, memoryIndexPath, capSummary } from "../../hooks/lib/handoff.mjs";

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

console.log("\nthe gate cannot be disarmed by a lazy summary (#8232)");
{
  // #8232: the summarizer was asked for five sections, none of them READ FIRST, so every machine
  // handoff produced an empty want-list and the gate passed vacuously. A fake scrooge captures the
  // system prompt buildSummary actually sends, then replies with a canned summary in exactly the old
  // five-section shape — the lazy output the floor has to catch.
  const VARS = ["RELAY_URL", "TRANTOR_SCROOGE_BIN", "TRANTOR_NO_SCROOGE", "TRANTOR_STATE_HANDOFF", "RELAY_PROJECT", "RELAY_AGENT", "RELAY_SESSION", "HERDR_PANE_ID", "TRANTOR_ORCH"];
  const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  let projDir = "", memRoot = "";
  try {
    for (const k of VARS) delete process.env[k];
    process.env.RELAY_URL = "http://127.0.0.1:1";   // storm guard: dead port → fail-open, offline

    projDir = mkdtempSync(join(tmpdir(), "recap-proj-"));
    memRoot = join(homedir(), ".claude", "projects", projDir.replaceAll("/", "-"));
    const memIndex = join(memRoot, "memory", "MEMORY.md");
    mkdirSync(join(memRoot, "memory"), { recursive: true });
    writeFileSync(memIndex, "# index — the durable record lives here\n");
    ok("memoryIndexPath resolves the project's index at the encoded-cwd location", memoryIndexPath(projDir) === memIndex, memoryIndexPath(projDir));
    ok("memoryIndexPath is empty for a project that has none", memoryIndexPath(join(tmpdir(), "recap-no-such-proj")) === "");

    const argsFile = join(dir, "scrooge-args.txt");
    const canned = "# HANDOFF — Lazy Machine\n\n## TASK\nShip the thing.\n\n## STATE\nHalf shipped.\n\n## KEY DECISIONS\nUse the simple shape.\n\n## OPEN THREADS & NEXT STEPS\n1. Finish shipping.\n\n## KEY FILES & locations\n- src/thing.mjs\n";
    const cannedFile = join(dir, "scrooge-canned.txt");
    writeFileSync(cannedFile, canned);
    const fake = join(dir, "fake-scrooge.sh");
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + JSON.stringify(argsFile) + "\ncat > /dev/null\ncat " + JSON.stringify(cannedFile) + "\n");
    chmodSync(fake, 0o755);
    process.env.TRANTOR_SCROOGE_BIN = fake;

    // A successor that DID something (Bash) but read nothing — tool_use for pathsReadIn, a text
    // turn so collectTurns has something to digest and buildSummary reaches the summarizer.
    const t = transcript([{ name: "Bash", input: { command: "git status" } }]);
    writeFileSync(t, readFileSync(t, "utf8") + "\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Taking over the takeover work." }] } }));
    const { record, file } = writeHandoff({ projectDir: projDir, sessionId: "rf-floor", transcript: t, trigger: "context-warn" });

    const asked = readFileSync(argsFile, "utf8");
    ok("the summarizer was ASKED for a READ FIRST section", /--system/.test(asked) && /READ FIRST/.test(asked), asked.slice(0, 160));
    ok("…and for the memory index, PRD and TDD by path", /memory index/.test(asked) && /PRD/.test(asked) && /TDD/.test(asked) && /path/.test(asked));

    ok("the lazy five-section summary is persisted, not discarded", record.summary.startsWith("# HANDOFF — Lazy Machine"));
    ok("…and the floor appended the memory index under READ FIRST", record.summary.includes("## READ FIRST") && record.summary.includes(memIndex));
    const want = readFirstPaths(record.summary);
    ok("the machine-written record yields a NON-EMPTY want-list", want.length === 1 && want[0] === memIndex, JSON.stringify(want));
    const rf = pathsReadIn(t, want);
    ok("a successor who opened none of it is reported as having missed it", rf.missed.length === 1 && rf.missed[0] === memIndex && rf.read.length === 0, JSON.stringify(rf));
    rmSync(file, { force: true });   // never leak into the live handoffs dir

    // A compliant summary is left alone: the floor must not double-append or conscript extras.
    const rec2 = writeHandoff({ projectDir: projDir, sessionId: "rf-ok", transcript: t, trigger: "context-warn", summary: SUMMARY });
    const want2 = readFirstPaths(rec2.record.summary);
    ok("a summary that already names read-first paths gets no floor appended",
      want2.length === 3 && !want2.includes(memIndex), JSON.stringify(want2));
    rmSync(rec2.file, { force: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (projDir) rmSync(projDir, { recursive: true, force: true });
    if (memRoot) rmSync(memRoot, { recursive: true, force: true });
  }
}

// The gate and the render must agree on the list. A summary whose must-keeps are heavy pushes the
// elidables out at 4KB, and READ FIRST was one of them: the ledger then demanded files the successor
// was never shown, which is worse than no gate at all (#8232 follow-up on #8222's section-aware cut).
{
  const big = (n) => "x".repeat(n);
  const heavy = ["# HANDOFF", `## TASK\n${big(2200)}`, `## STATE\n${big(2200)}`,
    "## READ FIRST\n- ~/.claude/projects/p/memory/MEMORY.md\n- docs/PRD.md",
    "## OPEN THREADS & NEXT STEPS\n1. first thread\n2. second thread",
    `## KEY FILES\n${big(500)}`].join("\n\n");
  const demanded = readFirstPaths(heavy);
  const shown = readFirstPaths(capSummary(heavy, 4096));
  ok("#8232: the render cannot drop the READ FIRST list the gate checks", shown.length === demanded.length && demanded.length === 2, JSON.stringify({ demanded, shown }));
  ok("#8232: …and the work order still survives beside it", capSummary(heavy, 4096).includes("1. first thread"));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
