#!/usr/bin/env node
// trantor — a handoff must not degrade into a raw transcript dump without saying why.
//
// Observed 2026-08-24 on a live crebral-health handoff. The successor got 19k characters of
// verbatim conversation that opened mid-sentence and stopped at "Checking how member names
// resolve:", losing three days of decisions, three uncommitted files, and four schema corrections.
// Its header said "no summarizer available".
//
// scrooge WAS installed and works: 56KB digest summarized in 29s. It lives in ~/.local/bin, which
// is not on a default PATH, so `command -v scrooge` fails for any handoff run from a hook, launchd
// or precompact — exactly the automatic paths. And the same "no summarizer available" string is
// printed when scrooge is present but the CALL fails, so the message never told anyone which.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir as _t } from "node:os";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor handoff-summarizer drill");

const src = readFileSync(join(ROOT, "hooks", "lib", "handoff.mjs"), "utf8");

console.log("\nscrooge is found even when PATH does not carry it:");
ok("resolution does not rely on `command -v` alone",
  /resolveScrooge|LOOKUP_DIRS|\.local\/bin/.test(src), "still just `command -v scrooge`");
ok("…and the known install locations are searched",
  /\.local\/bin/.test(src) && /homebrew|usr\/local/.test(src), "no fallback lookup dirs");
ok("…and the resolved ABSOLUTE path is what gets executed",
  !/execSync\(`scrooge /.test(src), "still exec'ing the bare name, which needs PATH");

console.log("\nA degraded handoff says WHY it is degraded:");
ok("'not installed' and 'call failed' are different messages",
  /summarizer failed|scrooge failed:/.test(src) && /not installed|summarizer unavailable/.test(src),
  "one message still covers both cases");
ok("the reason travels IN the handoff, not just to stderr",
  /(failed|unavailable)[^\n]*\$\{/.test(src), "reason is not interpolated into the returned text");

console.log("\nThe fallback behaves, not merely reads, correctly:");
{
  // Behavioural rather than string-matching: force the degraded path and inspect what a successor
  // would actually receive.
  process.env.TRANTOR_NO_SCROOGE = "1";
  const { buildSummary } = await import(join(ROOT, "hooks", "lib", "handoff.mjs"));
  const w = mkdtempSync(join(tmpdir(), "tt-sum-"));
  const tp = join(w, "t.jsonl");
  const turn = (role, text) => JSON.stringify({ type: role, message: { role, content: [{ type: "text", text }] } });
  writeFileSync(tp, Array.from({ length: 400 }, (_, i) =>
    turn(i % 2 ? "assistant" : "user", `turn ${i}: ` + "some substantive conversation text ".repeat(12))).join("\n"));
  const out = buildSummary(tp);
  ok("it is clearly marked as degraded", /DEGRADED HANDOFF/.test(out), out.slice(0, 120));
  ok("…names the reason", /no summarizer is installed/.test(out), out.slice(0, 200));
  ok("…warns that it omits older context", /OMITS|memory files/.test(out), out.slice(0, 260));
  const body = out.split(")*\n\n").pop() || "";
  ok("…and the transcript tail starts at a turn, not mid-word", /^(turn \d+|\[|#|\w+ \w+)/.test(body.trim()) && !/^\w{0,3}\b(?=\s)/.test(body.trim().slice(0, 4) + " "),
    JSON.stringify(body.trim().slice(0, 70)));
}

console.log("\nAnd the budget reflects reality (29s observed on a 56KB digest):");
ok("the summarize timeout is above 60s", /timeout: 1[2-9]\d_?\d{3}|timeout: [2-9]\d\d_?\d{3}/.test(src),
  (src.match(/timeout: [0-9_]+,\s*\n?\s*maxBuffer/) || ["none found"])[0]);

console.log(`\n${fail === 0 ? "✅" : "❌"} handoff-summarizer: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
