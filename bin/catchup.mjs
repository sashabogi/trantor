#!/usr/bin/env node
// trantor catchup — "where are we on this project?" on demand. Reads the continuous
// board (the durable, cross-session project record), the recent git log, and — if
// scrooge is on PATH — synthesizes a short narrative. The SessionStart hook already
// injects the structured snapshot every start; this is the richer brief you ask for
// when you want it. Run from inside a project: `trantor catchup`.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { resolveProject } from "../lib/project.mjs";

// Signed read via the shared client (2026-07-31, agent-UX audit): hand-rolled relayUrl missed the
// per-project hubs map; unsigned reads 401 under enforce. signedGet resolves + signs per call.
import { relayUrl, signedGet } from "../hooks/lib/api.mjs";
const haveScrooge = () => { try { execSync("command -v scrooge", { stdio: "ignore" }); return true; } catch { return false; } };

const dir = process.cwd();
const project = resolveProject(dir);
const url = relayUrl(project);

let cu = null;
{
  const r = await signedGet(`/catchup?project=${encodeURIComponent(project)}`, { timeoutMs: 4000 });
  if (r.ok) cu = r.json; else console.error(`could not reach hub at ${url} (status ${r.status})`);
}
let gitlog = "";
try { gitlog = execSync(`git -C ${JSON.stringify(dir)} log --oneline -12 2>/dev/null`, { encoding: "utf8" }).trim(); } catch {}

const line = (arr) => (arr || []).map(t => `  #${t.id} ${String(t.title).slice(0, 80)}${t.assignee ? ` @${t.assignee}` : ""}`).join("\n");
console.log(`\n📋 trantor catchup — ${project}\n${"─".repeat(48)}`);
if (cu && cu.total > 0) {
  if (cu.brief) console.log(`Brief: ${cu.brief}\n`);
  const c = cu.counts;
  console.log(`Cards: ${cu.total} — ${c.done} done · ${c.doing} doing · ${c.testing} testing · ${c.todo} todo · ${c.failed} failed · ${c.blocked} blocked`);
  if (cu.doing?.length)      console.log(`\nIn progress:\n${line(cu.doing)}`);
  if (cu.testing?.length)    console.log(`\nIn testing:\n${line(cu.testing)}`);
  if (cu.failed?.length)     console.log(`\nFailed (needs attention):\n${line(cu.failed)}`);
  if (cu.blocked?.length)    console.log(`\nBlocked:\n${line(cu.blocked)}`);
  if (cu.todo?.length)       console.log(`\nQueued:\n${line(cu.todo)}`);
  if (cu.recentDone?.length) console.log(`\nRecently done:\n${line(cu.recentDone)}`);
} else {
  console.log(`No cards on the board for "${project}" yet.`);
}
if (gitlog) console.log(`\nRecent commits:\n${gitlog.split("\n").map(l => "  " + l).join("\n")}`);

if (haveScrooge() && (cu?.total || gitlog)) {
  const ctx = `PROJECT: ${project}\n\nBOARD:\n${JSON.stringify(cu, null, 2)}\n\nRECENT COMMITS:\n${gitlog}`;
  const sys = "You are briefing someone resuming this project. From the board state + git log, write a SHORT 'where are we' narrative: what's built, what's in flight, what's next, and any risk (failed/blocked cards, or a stale card whose work looks already done elsewhere). 6-10 lines. No preamble.";
  try {
    console.log(`\n${"─".repeat(48)}\nWhere we are:\n`);
    console.log(execSync(`scrooge -t summarize -d medium --system ${JSON.stringify(sys)}`, { input: ctx, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 }).trim());
  } catch (e) { console.error(`(scrooge brief skipped: ${e.message})`); }
} else if (!haveScrooge()) {
  console.log(`\n(install scrooge for a synthesized narrative)`);
}
console.log("");
