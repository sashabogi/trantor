#!/usr/bin/env node
// Trantor State P1 — the store (TDD §4.4). The four claims this suite has to actually prove, as
// opposed to restate:
//
//   1. A wrong-rev commit does not clobber. STALE is worth nothing if the bytes changed anyway,
//      so every CAS assertion re-reads the file and checks the loser's write is absent.
//   2. recover() CLEARS a stale credit. Asserted against a real git worktree with a real
//      `git hash-object`, and paired with its negative: an UNTOUCHED credited file keeps its
//      green. Without that pair the clearing test would pass on a function that cleared
//      everything unconditionally.
//   3. Recovery does not read the journal. Proved by deleting the journal, and separately by
//      writing a journal full of ops that would restore lost items and showing recovery ignores
//      it. §4.4 claims the journal is forensics-only; this is where that claim is checked.
//   4. A migration the store refuses leaves the original readable, and the read stays loud.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPS, emptyState, stateError } from "../../lib/state/schema.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

const ROOT = mkdtempSync(join(tmpdir(), "trantor-state-store-"));
process.env.AGENT_BUS_DIR = join(ROOT, "bus");

// Imported AFTER AGENT_BUS_DIR is set only for readability — busDir() reads the env on every call,
// which is what lets one process test several bus roots.
const store = await import("../../lib/state/store.mjs");
const {
  GC_AGE_MS, JOURNAL_LINES, STALE, appendJournal, commit, gcSidecars, gitTouched, hashPaths,
  opsPath, readJournal, readState, recover, sanitizeComponent, statePath, turncutPaths,
} = store;

const PROJ = "trantor";
const SEAT = "claude:trantor";
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

function tmpRepo() {
  const dir = mkdtempSync(join(ROOT, "repo-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "seat@trantor.test"], dir);
  git(["config", "user.name", "seat"], dir);
  return dir;
}

// ---------------------------------------------------------------- 0. paths + sanitisation
console.log("\npaths + sanitisation (checklist 0)");
ok("a session id's `:` folds to `_`, it is not rejected", sanitizeComponent("claude:trantor") === "claude_trantor");
ok("`.` is rejected, not folded — it addresses the directory, not a file in it", sanitizeComponent(".") === null);
ok("`..` is rejected", sanitizeComponent("..") === null);
ok("empty and whitespace are rejected", sanitizeComponent("") === null && sanitizeComponent("   ") === null);
ok("a traversal attempt cannot escape: every `/` folds", sanitizeComponent("../../etc/passwd") === ".._.._etc_passwd");
ok("the safe alphabet survives untouched", sanitizeComponent("glm-2.trantor_x") === "glm-2.trantor_x");

const P6900 = statePath(SEAT, 6900, PROJ);
ok("the sidecar sits under busDir()/state/<project>/", P6900.startsWith(join(process.env.AGENT_BUS_DIR, "state", PROJ)));
ok("named <seat>--<card>.json with the seat sanitised", P6900.endsWith("claude_trantor--6900.json"), P6900);
ok("the sidecar is per SEAT-CARD: a second card is a DIFFERENT file",
  statePath(SEAT, 6901, PROJ) !== P6900);
ok("...and a second seat on the same card is a different file too",
  statePath("glm:trantor", 6900, PROJ) !== P6900);
ok("a traversing seat still lands inside the state dir",
  statePath("../../../etc", 6900, PROJ).startsWith(join(process.env.AGENT_BUS_DIR, "state", PROJ)));
ok("an unusable seat has no path at all, rather than a guessed one", statePath("..", 6900, PROJ) === null);
ok("a non-integer card has no path", statePath(SEAT, 6.5, PROJ) === null && statePath(SEAT, "6900", PROJ) === null);
ok("the journal sits beside its sidecar", opsPath(SEAT, 6900, PROJ) === P6900.replace(/\.json$/, ".ops.jsonl"));
ok("turncut markers are looked for where the runner writes them",
  turncutPaths("claude", PROJ).some(p => p.endsWith(`turncut-claude-${PROJ}`)));

// ---------------------------------------------------------------- 1. atomic write
console.log("\natomic write (checklist 1)");
const s0 = emptyState(6900, SEAT);
s0.task = "build the store";
const w0 = commit({ ...s0, rev: 1 }, 0, { seat: SEAT, card: 6900, project: PROJ });
ok("the first commit lands", w0.ok === true, JSON.stringify(w0));
ok("the file is mode 0600 — a sidecar is not world-readable", (statSync(P6900).mode & 0o777) === 0o600);
ok("what lands parses whole", stateError(JSON.parse(readFileSync(P6900, "utf8"))) === "");
const stateDirFiles = () => readdirSync(join(process.env.AGENT_BUS_DIR, "state", PROJ));
ok("no temp file is left behind", stateDirFiles().every(f => !f.endsWith(".tmp")), stateDirFiles().join(", "));

// The property a rename buys: a reader never sees a partial file. Written over repeatedly with
// states of very different sizes, every intermediate read is a whole, schema-valid object.
let rev = 1, torn = 0;
for (let i = 0; i < 25; i++) {
  const big = emptyState(6900, SEAT);
  big.rev = rev + 1;
  big.task = "x".repeat(i % 2 ? CAPS.TASK : 3);
  big.next = Array.from({ length: i % 2 ? 30 : 1 }, (_, k) => ({ id: `n${k}`, text: "y".repeat(200) }));
  const r = commit(big, rev, { seat: SEAT, card: 6900, project: PROJ });
  if (!r.ok) { torn++; continue; }
  rev = r.rev;
  if (stateError(JSON.parse(readFileSync(P6900, "utf8"))) !== "") torn++;
}
ok(`25 overwrites of wildly different sizes, zero partial reads (rev now ${rev})`, torn === 0 && rev === 26);
ok("still no temp litter after 25 writes", stateDirFiles().every(f => !f.endsWith(".tmp")));

// ---------------------------------------------------------------- 2. rev CAS
console.log("\nrev compare-and-swap (checklist 2) — and STALE must not have clobbered");
const cur = JSON.parse(readFileSync(P6900, "utf8"));
const loser = { ...emptyState(6900, SEAT), task: "THE LOSER WROTE THIS", rev: cur.rev + 1 };
const stale = commit(loser, cur.rev - 1, { seat: SEAT, card: 6900, project: PROJ });
ok("a commit at a rev the disk has moved past is rejected", stale.ok === false);
ok("...with code STALE", stale.code === STALE, JSON.stringify(stale));
ok("...naming the rev actually on disk, so the driver can re-read", stale.rev === cur.rev);
const afterStale = JSON.parse(readFileSync(P6900, "utf8"));
ok("THE LOSER'S WRITE IS NOT ON DISK — STALE means refused, not merely reported",
  afterStale.task !== "THE LOSER WROTE THIS" && afterStale.rev === cur.rev, JSON.stringify(afterStale).slice(0, 120));
const winner = { ...cur, task: "the winner", rev: cur.rev + 1 };
const won = commit(winner, cur.rev, { seat: SEAT, card: 6900, project: PROJ });
ok("the same write at the right rev lands — the guard is the rev, not the content", won.ok === true);
ok("...and rev advanced by exactly one", JSON.parse(readFileSync(P6900, "utf8")).rev === cur.rev + 1);

const FRESH = statePath(SEAT, 6999, PROJ);
ok("a first write to a missing sidecar expects rev 0 and lands",
  commit({ ...emptyState(6999, SEAT), rev: 1 }, 0, { seat: SEAT, card: 6999, project: PROJ }).ok === true && existsSync(FRESH));
rmSync(FRESH);
const vanished = commit({ ...emptyState(6999, SEAT), rev: 8 }, 7, { seat: SEAT, card: 6999, project: PROJ });
ok("a sidecar that VANISHED under a live turn is STALE, not a silent re-create",
  vanished.ok === false && vanished.code === STALE, JSON.stringify(vanished));
ok("...and nothing was written", existsSync(FRESH) === false);

const bad = { ...emptyState(6998, SEAT), rev: 1 };
bad.notes = 42;
const refused = commit(bad, 0, { seat: SEAT, card: 6998, project: PROJ });
ok("an invalid state is refused rather than written — a reader's only guarantee is that it parses",
  refused.ok === false && refused.code === "SCHEMA", JSON.stringify(refused));
ok("...and no file appeared", existsSync(statePath(SEAT, 6998, PROJ)) === false);
ok("the store never invents a STALE for a bad path", commit(bad, 0, { seat: "..", card: 1, project: PROJ }).code === "SCHEMA");

// ---------------------------------------------------------------- 3+4. recover()
console.log("\nrecover() from a cut turn (checklist 3, 4)");
const repo = tmpRepo();
writeFileSync(join(repo, "credited.mjs"), "export const a = 1;\n");
writeFileSync(join(repo, "untouched.mjs"), "export const b = 2;\n");
writeFileSync(join(repo, "doomed.mjs"), "export const c = 3;\n");
git(["add", "-A"], repo);
git(["commit", "-qm", "base"], repo);

const shaOf = (p) => git(["hash-object", "--", p], repo).trim();
const credited = shaOf("credited.mjs"), untouchedSha = shaOf("untouched.mjs"), doomedSha = shaOf("doomed.mjs");
ok("git hash-object is the sha source, matching the one the gate records", /^[0-9a-f]{40}$/.test(credited));
ok("hashPaths agrees with git, path for path",
  hashPaths(["credited.mjs", "untouched.mjs"], repo).get("credited.mjs") === credited);
ok("a path that is gone hashes to null, which clears a credit exactly as a moved sha does",
  hashPaths(["never-existed.mjs"], repo).get("never-existed.mjs") === null);

const cutState = () => {
  const s = emptyState(6900, SEAT);
  s.cursor = { turn: 7, ts: 1, by: SEAT };
  s.files = {
    "credited.mjs": { touched: true, verified: true, hash: credited },
    "untouched.mjs": { touched: true, verified: true, hash: untouchedSha },
    "doomed.mjs": { touched: true, verified: true, hash: doomedSha },
  };
  return s;
};

// The cut turn's edit: one credited file changes under its credit, one is deleted, one is not
// touched at all. That third file is what makes the first two assertions mean something.
writeFileSync(join(repo, "credited.mjs"), "export const a = 1; // the cut turn edited this\n");
rmSync(join(repo, "doomed.mjs"));
writeFileSync(join(repo, "brandnew.mjs"), "export const d = 4;\n");

const rec = recover(cutState(), { cwd: repo, turn: 7 });
ok("the credit on a file whose bytes MOVED is cleared", rec.state.files["credited.mjs"].verified === false);
ok("...and its stale hash goes with it, so nothing can compare against it later",
  rec.state.files["credited.mjs"].hash === undefined);
ok("the credit on a DELETED file is cleared", rec.state.files["doomed.mjs"].verified === false);
ok("THE NEGATIVE CASE: an untouched credited file KEEPS its green — recovery is not a blanket wipe",
  rec.state.files["untouched.mjs"].verified === true && rec.state.files["untouched.mjs"].hash === untouchedSha);
ok("exactly the two moved paths are reported cleared",
  rec.cleared.sort().join() === "credited.mjs,doomed.mjs", rec.cleared.join());
ok("touched is re-derived from git — a file the dead turn created is marked",
  rec.state.files["brandnew.mjs"]?.touched === true);
ok("...and so is the edited one", rec.state.files["credited.mjs"].touched === true);
ok("git status is the source, not the journal: gitTouched sees all three changes",
  ["credited.mjs", "doomed.mjs", "brandnew.mjs"].every(p => gitTouched(repo).includes(p)), gitTouched(repo).join(" "));
ok("the notes line says the turn was cut, and NAMES THE COUNT (checklist 4)",
  rec.state.notes.includes("recovered: turn 7 was cut")
  && rec.state.notes.includes("2 stale verifications cleared"), rec.state.notes);
ok("the recovered state is still schema-valid", stateError(rec.state) === "");
ok("recover does not mutate its input — the caller's copy is untouched",
  cutState().files["credited.mjs"].verified === true);

// A rename is two paths, and both are touched: the original because it is gone, the new one
// because it is new. This is the -z parsing branch most likely to be silently wrong.
const repo2 = tmpRepo();
writeFileSync(join(repo2, "old-name.mjs"), "export const x = 1;\n");
git(["add", "-A"], repo2); git(["commit", "-qm", "base"], repo2);
git(["mv", "old-name.mjs", "new-name.mjs"], repo2);
const renamed = gitTouched(repo2);
ok("a rename yields BOTH paths, not just the new one",
  renamed.includes("new-name.mjs") && renamed.includes("old-name.mjs"), renamed.join(" "));

// A path with a space would be C-quoted by `git status --short`; `-z` never quotes.
const repo3 = tmpRepo();
writeFileSync(join(repo3, "a file with spaces.mjs"), "export const y = 1;\n");
ok("a path with spaces comes back verbatim, not quoted",
  gitTouched(repo3).includes("a file with spaces.mjs"), JSON.stringify(gitTouched(repo3)));
ok("a non-repo cwd degrades to no facts rather than throwing", gitTouched(ROOT).length >= 0);

// ---------------------------------------------------------------- readState wiring
console.log("\nreadState: create, migrate, and the cut-marker path");
const NEWCARD = 6910;
const first = readState(SEAT, NEWCARD, { project: PROJ, by: SEAT });
ok("a missing sidecar reads as a blank state, not an error", first.ok === true && first.created === true);
ok("...carrying the card it was asked for", first.state.card === NEWCARD && first.state.rev === 0);
ok("...and nothing is written just by reading", existsSync(statePath(SEAT, NEWCARD, PROJ)) === false);

const v2 = {
  schema_version: 2, card: 6911, task: "old work",
  done: [{ id: "d1", text: "shipped" }], in_flight: [], next: [], blockers: [],
  files: { "lib/state/store.mjs": { touched: true, verified: false } },
  verify: {}, notes: "", ext: {}, cursor: { turn: 3, ts: 1, by: SEAT },
};
mkdirSync(join(process.env.AGENT_BUS_DIR, "state", PROJ), { recursive: true });
writeFileSync(statePath(SEAT, 6911, PROJ), JSON.stringify(v2));
const mig = readState(SEAT, 6911, { project: PROJ });
ok("a v2 sidecar migrates on read", mig.ok === true && mig.migrated === true, JSON.stringify(mig).slice(0, 140));
ok("...to a valid v3 state", stateError(mig.state) === "" && mig.state.schema_version === 3);

const CORRUPT = statePath(SEAT, 6912, PROJ);
writeFileSync(CORRUPT, "{ this is not json");
const corrupt = readState(SEAT, 6912, { project: PROJ });
ok("a corrupt sidecar is MIGRATE_FAILED, never a silently fresh state",
  corrupt.ok === false && corrupt.code === "MIGRATE_FAILED", JSON.stringify(corrupt));
ok("the original bytes are preserved beside it", existsSync(CORRUPT.replace(/\.json$/, ".vunknown.json")));
ok("...and the original file is left untouched, so the read stays loud on every retry",
  readFileSync(CORRUPT, "utf8") === "{ this is not json" && readState(SEAT, 6912, { project: PROJ }).ok === false);

const UNMIG = statePath(SEAT, 6913, PROJ);
writeFileSync(UNMIG, JSON.stringify({ schema_version: 1, card: 6913 }));
const unmig = readState(SEAT, 6913, { project: PROJ });
ok("an object with no migration path is MIGRATE_FAILED", unmig.ok === false && unmig.code === "MIGRATE_FAILED");
ok("...and is kept under .v1.json rather than half-upgraded", existsSync(UNMIG.replace(/\.json$/, ".v1.json")));

// The whole cut path, end to end: marker on disk, sidecar with a now-stale credit, git as truth.
const CUTCARD = 6914;
const CUTPATH = statePath(SEAT, CUTCARD, PROJ);
const onDisk = cutState();
onDisk.card = CUTCARD;
onDisk.rev = 5;
writeFileSync(CUTPATH, JSON.stringify(onDisk));
const marker = turncutPaths("claude", PROJ)[0];
mkdirSync(join(process.env.AGENT_BUS_DIR), { recursive: true });
writeFileSync(marker, "");
const cutRead = readState(SEAT, CUTCARD, { project: PROJ, cwd: repo, agent: "claude" });
ok("a cut marker triggers recovery on the next read", cutRead.ok === true && cutRead.recovered !== null);
ok("...clearing the credits that moved", cutRead.state.files["credited.mjs"].verified === false);
ok("...keeping the one that did not", cutRead.state.files["untouched.mjs"].verified === true);
ok("...and reporting which ones went", cutRead.recovered.cleared.length === 2, JSON.stringify(cutRead.recovered));
ok("the repair is PERSISTED before the marker is cleared — a repair the next turn cannot see did not happen",
  cutRead.recovered.persisted === true && JSON.parse(readFileSync(CUTPATH, "utf8")).files["credited.mjs"].verified === false);
ok("the marker is gone, so recovery does not run again on the next read", existsSync(marker) === false);
ok("...and the next read is an ordinary one", readState(SEAT, CUTCARD, { project: PROJ, cwd: repo, agent: "claude" }).recovered === null);

// ---------------------------------------------------------------- 5. the journal
console.log("\nops journal — forensics and replay ONLY (checklist 5)");
const JCARD = 6920;
const jOps = [{ add: { list: "in_flight", item: { id: "x1", text: "wire the store" } } }];
const js = { ...emptyState(JCARD, SEAT), rev: 1 };
ok("a committed patch is journalled",
  commit(js, 0, { seat: SEAT, card: JCARD, project: PROJ, ops: jOps }).ok === true);
const jread = readJournal(SEAT, JCARD, PROJ);
ok("the entry round-trips with its rev, turn and ops", jread.length === 1 && jread[0].rev === 1 && jread[0].ops[0].add.item.id === "x1", JSON.stringify(jread));
const staleJ = commit({ ...emptyState(JCARD, SEAT), rev: 9 }, 8, { seat: SEAT, card: JCARD, project: PROJ, ops: jOps });
ok("a REJECTED commit journals nothing — the journal is accepted patches, not attempts",
  staleJ.code === STALE && readJournal(SEAT, JCARD, PROJ).length === 1);
for (let i = 0; i < JOURNAL_LINES + 40; i++) appendJournal(SEAT, JCARD, PROJ, { ts: i, rev: i, turn: i, by: SEAT, ops: [] });
const capped = readJournal(SEAT, JCARD, PROJ);
ok(`the journal is capped at ${JOURNAL_LINES} lines`, capped.length === JOURNAL_LINES, String(capped.length));
ok("...and it is the NEWEST lines that survive", capped[capped.length - 1].rev === JOURNAL_LINES + 39);
ok("a torn tail line is skipped, not fatal — a forensics file is not a contract", (() => {
  const p = opsPath(SEAT, JCARD, PROJ);
  writeFileSync(p, `${readFileSync(p, "utf8")}{"ts":1,"rev`);
  return readJournal(SEAT, JCARD, PROJ).length === JOURNAL_LINES;
})());

// §4.4's load-bearing claim, checked rather than restated: recovery never reads this file.
const RCARD = 6921;
const rState = cutState();
rState.card = RCARD;
rState.in_flight = [];
writeFileSync(statePath(SEAT, RCARD, PROJ), JSON.stringify({ ...rState, rev: 2 }));
appendJournal(SEAT, RCARD, PROJ, {
  ts: 1, rev: 3, turn: 8, by: SEAT,
  ops: [{ add: { list: "in_flight", item: { id: "ghost", text: "an op the dead turn journalled" } } }],
});
writeFileSync(marker, "");
const noReplay = readState(SEAT, RCARD, { project: PROJ, cwd: repo, agent: "claude" });
ok("recovery does NOT replay a journalled op back into the state", noReplay.ok === true
  && noReplay.state.in_flight.length === 0, JSON.stringify(noReplay.state.in_flight));
ok("...and rev is not advanced by anything the journal claims", noReplay.state.rev === 2);
rmSync(opsPath(SEAT, RCARD, PROJ));
writeFileSync(marker, "");
const noJournal = readState(SEAT, RCARD, { project: PROJ, cwd: repo, agent: "claude" });
ok("with the journal DELETED, recovery still reconstructs from git — it was never a source",
  noJournal.ok === true && noJournal.state.files["brandnew.mjs"]?.touched === true
  && noJournal.state.files["credited.mjs"].verified === false);

// ---------------------------------------------------------------- 6. gc
console.log("\ngc (checklist 6)");
const GPROJ = "gcproj";
const OLD = Date.now() - GC_AGE_MS - 60_000;
const mk = (card, mtimeMs) => {
  const p = statePath(SEAT, card, GPROJ);
  mkdirSync(join(process.env.AGENT_BUS_DIR, "state", GPROJ), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...emptyState(card, SEAT), rev: 1 }));
  writeFileSync(`${p.slice(0, -5)}.ops.jsonl`, "{}\n");
  writeFileSync(`${p.slice(0, -5)}.v2.json`, "{}");
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
};
const oldTerminal = mk(1, OLD), oldLive = mk(2, OLD), freshTerminal = mk(3, Date.now());
const terminal = new Set([1, 3]);
const sweep = gcSidecars({ project: GPROJ, isTerminal: (c) => terminal.has(c) });
const paths = sweep.candidates.map(c => c.path);
ok("an old sidecar for a terminal card is collectable", paths.includes(oldTerminal), paths.join(" "));
ok("an old sidecar for a card still being worked is NOT", !paths.includes(oldLive));
ok("a terminal card whose sidecar is fresh is NOT — 14 days is the rule", !paths.includes(freshTerminal));
ok("the default answer is a list, not a deletion", sweep.removed.length === 0 && existsSync(oldTerminal));
const applied = gcSidecars({ project: GPROJ, isTerminal: (c) => terminal.has(c), apply: true });
ok("with apply, the sidecar goes", existsSync(oldTerminal) === false);
ok("...and its journal and preserved copies go with it, so gc leaves no orphans",
  existsSync(`${oldTerminal.slice(0, -5)}.ops.jsonl`) === false && existsSync(`${oldTerminal.slice(0, -5)}.v2.json`) === false,
  applied.removed.join(" "));
ok("the live card's sidecar survives the sweep", existsSync(oldLive) === true);
ok("a project with no state dir sweeps to nothing rather than throwing",
  gcSidecars({ project: "no-such-project", isTerminal: () => true }).candidates.length === 0);

rmSync(ROOT, { recursive: true, force: true });
done();
