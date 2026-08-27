#!/usr/bin/env node
// `trantor integrate` — collect the crew's work, prove it, ship it.
//
// The steps are the ones the orchestrator already performs by hand. The dials decide how far it is
// allowed to go on its own, and every stop says which dial stopped it, so "why didn't it push"
// always has an answer.
import { resolveProject } from "../lib/project.mjs";
import { resolveAutonomy } from "../lib/autonomy.mjs";
import { seatWorktrees, commitSeatWork, seatAhead, mergeSeat, verify, git } from "../lib/integrate.mjs";

const D = "\x1b[2m", B = "\x1b[1m", G = "\x1b[32m", Y = "\x1b[33m", RED = "\x1b[31m", R = "\x1b[0m";
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const repo = process.cwd();
const project = resolveProject(repo);
const a = resolveAutonomy(project);

console.log(`${B}integrate${R} · ${project}   ${D}commit=${a.commit ? "on" : "off"} push=${a.push ? "on" : "off"} deploy=${a.deploy ? "on" : "off"}${R}`);

const base = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
const seats = seatWorktrees(project);
if (!seats.length) {
  console.log(`${D}no seat worktrees for ${project} — nothing to integrate${R}`);
  process.exit(0);
}

// 1. Each seat's uncommitted work becomes a commit AUTHORED TO THAT SEAT, so git blame stays a
//    truthful answer to "who wrote this" once integration stops being manual.
let blocked = false;
for (const w of seats) {
  const dirty = git(w.dir, ["status", "--porcelain"]);
  if (!dirty) { console.log(`  ${D}${w.agent}: clean${R}`); continue; }
  if (!a.commit) {
    console.log(`  ${Y}${w.agent}: has uncommitted work, and commit is off${R} ${D}(trantor autonomy set commit on)${R}`);
    blocked = true;
    continue;
  }
  if (dry) { console.log(`  ${D}[dry] would commit ${dirty.split("\n").length} file(s) as ${w.agent}${R}`); continue; }
  const r = commitSeatWork(w);
  console.log(`  ${G}${w.agent}: committed ${r.sha}${R}`);
}

// 2. Merge what each seat is ahead by. A conflict stops the pass: two seats on the same lines is
//    the collision the overseer exists to surface, not something to resolve silently.
const merged = [];
for (const w of seats) {
  const { branch, ahead } = seatAhead(w, base);
  if (!ahead) continue;
  if (dry) { console.log(`  ${D}[dry] would merge ${branch} (${ahead} commit(s))${R}`); merged.push(branch); continue; }
  const m = mergeSeat(repo, branch);
  if (m.conflict) {
    console.log(`  ${RED}${branch}: CONFLICT — left untouched${R}\n${D}${m.detail}${R}`);
    blocked = true;
    continue;
  }
  if (m.merged) { console.log(`  ${G}merged ${branch} (${ahead} commit(s))${R}`); merged.push(branch); }
}

if (blocked) {
  console.log(`\n${Y}stopping here — resolve the above before anything ships${R}`);
  process.exit(1);
}
if (!merged.length && !dry) {
  console.log(`${D}nothing new to integrate${R}`);
  process.exit(0);
}

// 3. Proof. This gate ignores the dial on purpose: unverified work does not leave the machine,
//    whatever the operator turned on.
if (dry) { console.log(`${D}[dry] would verify, then push=${a.push}${R}`); process.exit(0); }
console.log(`\n${D}verifying…${R}`);
const v = verify(repo);
if (!v.ok) {
  console.log(`${RED}verify FAILED (${v.cmd}) — not pushing${R}\n${D}${v.tail}${R}`);
  process.exit(1);
}
console.log(`${G}verified (${v.cmd})${R}`);

// 4. Ship.
if (!a.push) {
  console.log(`${D}push is off — integrated and verified locally (trantor autonomy set push on)${R}`);
  process.exit(0);
}
git(repo, ["push"]);
console.log(`${G}pushed ${base}${R}`);
if (a.deploy) console.log(`${D}deploy is on, but this project has no deploy step wired here yet${R}`);
