#!/usr/bin/env node
// Trantor State P2 — `trantor state` (TDD §10). Four claims this suite has to actually prove:
//
//   1. `show` is READ-ONLY. Inspection that edits the bytes you came to read is worse than no
//      inspection at all, so the no-write assertion carries a POSITIVE CONTROL: the same sidecar,
//      same turncut marker, read through readState's ordinary path, IS repaired and the marker IS
//      consumed. Without that half, "nothing changed" would also pass on a command that did nothing.
//   2. `validate` reports the rejection SHAPE — code · at · message — for each of the three ways a
//      sidecar goes bad (not JSON, no migration path, schema-invalid), and exits non-zero.
//   3. `reset` cannot delete by accident: no --force and no TTY refuses, and the file is still
//      there afterwards. Asserted on disk, not on the exit code.
//   4. `gc` never guesses. A card that is not terminal is kept, a terminal card inside the window
//      is kept, and an unreachable hub deletes NOTHING — because an unknown status must not read
//      as finished.
//
// Everything runs against a temp AGENT_BUS_DIR and a temp project name, so no real seat's working
// memory is in reach of this file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyState } from "../../lib/state/schema.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

const ROOT = mkdtempSync(join(tmpdir(), "trantor-state-cli-"));
const BUS = join(ROOT, "bus");
process.env.AGENT_BUS_DIR = BUS;

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STATE_BIN = join(REPO, "bin", "state.mjs");
const CLI_BIN = join(REPO, "bin", "cli.mjs");

// Imported after AGENT_BUS_DIR is set, exactly as test-store.mjs does: busDir() reads the env on
// every call, and this keeps the paths the test writes identical to the ones the CLI will read.
const { GC_AGE_MS, opsPath, readState, statePath, turncutPaths } = await import("../../lib/state/store.mjs");

const PROJ = "trantor-cli-test";
const SEAT = "claude:trantor";

// ── a hub that answers /tasks, so gc has real card statuses to read ───────────────────────────
//
// It runs in its OWN process, which is not a style choice: this suite drives the CLI with
// spawnSync, and a server listening on the test's own event loop can never accept a connection
// while spawnSync is blocking it. An in-process hub fails every gc case with "hub unreachable" —
// which is a real gc verdict, so the suite would look like it was exercising the refusal path
// when it was really deadlocking on itself. Card statuses travel through a file so the parent can
// change them between cases.
const TASKS_FILE = join(ROOT, "tasks.json");
const PORT_FILE = join(ROOT, "hub.port");
const HUB_SCRIPT = join(ROOT, "fake-hub.mjs");
writeFileSync(TASKS_FILE, "[]");
writeFileSync(HUB_SCRIPT, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const [,, tasksFile, portFile] = process.argv;
const hub = createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/tasks")) {
      let tasks = [];
      try { tasks = JSON.parse(readFileSync(tasksFile, "utf8")); } catch {}
      res.end(JSON.stringify({ tasks }));
    } else res.end(JSON.stringify({ ok: true }));
  });
});
hub.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(hub.address().port)));
`);
const hub = spawn(process.execPath, [HUB_SCRIPT, TASKS_FILE, PORT_FILE], { stdio: "ignore" });
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
let HUB_URL = "";
for (let i = 0; i < 100 && !HUB_URL; i++) {
  sleep(50);
  if (existsSync(PORT_FILE)) HUB_URL = `http://127.0.0.1:${readFileSync(PORT_FILE, "utf8").trim()}`;
}
if (!HUB_URL) { console.log("  FAIL  the fake hub never came up — no gc case can run"); process.exit(1); }
const setCards = (rows) => writeFileSync(TASKS_FILE, JSON.stringify(rows));

const env = (extra = {}) => ({
  ...process.env,
  AGENT_BUS_DIR: BUS,
  RELAY_URL: HUB_URL,
  RELAY_SESSION: `test:${PROJ}`,
  ...extra,
});
const cli = (args, extra = {}) => {
  const r = spawnSync(process.execPath, [STATE_BIN, ...args, "--project", PROJ], {
    encoding: "utf8", env: env(extra), cwd: REPO, input: "",
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

function seed(card, patch = {}) {
  const s = { ...emptyState(card, SEAT), ...patch };
  const p = statePath(SEAT, card, PROJ);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(s)}\n`);
  return p;
}
/** Write raw bytes at a sidecar path — the only way to seed a sidecar the schema would refuse. */
function seedRaw(card, raw) {
  const p = statePath(SEAT, card, PROJ);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, raw);
  return p;
}
const backdate = (p, ms) => { const t = (Date.now() - ms) / 1000; utimesSync(p, t, t); };

// ── show ──────────────────────────────────────────────────────────────────────────────────────
{
  const path = seed(7001, {
    task: "render the sidecar readably",
    in_flight: [{ id: "cli-show", text: "the show verb", paths: ["bin/state.mjs"] }],
    done: [{ id: "p1", text: "the store landed", paths: ["lib/state/store.mjs"] }],
    blockers: [{ id: "hub", text: "hub unreachable" }],
    done_count: 1,
    files: { "lib/state/store.mjs": { touched: true, verified: true, hash: "abc123def456" },
             "bin/state.mjs": { touched: true, verified: false } },
    files_count: 2,
    verify: { tested: true, exit: 0, cmd: "node test/state/test-cli.mjs" },
    notes: "one note line",
    cursor: { turn: 7, ts: Date.now(), by: SEAT },
    rev: 12,
  });
  const r = cli(["show", SEAT, "7001"]);
  ok("show exits 0 on a good sidecar", r.status === 0, r.out);
  // Readable output IS the feature, so this asserts the SUBSTANCE is on screen, not that it ran.
  for (const needle of ["card 7001", "rev 12", "turn 7", SEAT, "render the sidecar readably",
                        "cli-show", "the show verb", "@bin/state.mjs", "hub unreachable",
                        "lib/state/store.mjs", "verified", "tested: true", "one note line", path]) {
    ok(`show renders ${JSON.stringify(needle)}`, r.out.includes(needle), r.out);
  }
  ok("show marks the unverified file without a check", /· bin\/state\.mjs/.test(r.out), r.out);
  ok("show names every list, empty ones included", ["done (", "in_flight (", "next (", "blockers ("].every(s => r.out.includes(s)), r.out);

  const j = cli(["show", SEAT, "7001", "--json"]);
  ok("show --json exits 0", j.status === 0, j.out);
  ok("show --json emits the bytes on disk, not a re-render",
    j.out.trim() === readFileSync(path, "utf8").trim(), j.out.slice(0, 200));
}

{
  const r = cli(["show", SEAT, "7099"]);
  ok("show on a missing sidecar exits non-zero", r.status === 1, String(r.status));
  ok("show on a missing sidecar says where it looked", r.out.includes(statePath(SEAT, 7099, PROJ)), r.out);
  const j = cli(["show", SEAT, "7099", "--json"]);
  ok("show --json on a missing sidecar is NO_SIDECAR + non-zero",
    j.status === 1 && JSON.parse(j.out).code === "NO_SIDECAR", j.out);
}

{
  const r = cli(["show", "..", "7001"]);
  ok("show refuses a seat with no safe path form", r.status === 2, `${r.status} ${r.out}`);
}

// show is read-only — with its positive control
{
  const path = seed(7002, { files: { "lib/state/store.mjs": { touched: true, verified: true, hash: "staleblob" } } });
  const marker = turncutPaths(SEAT, PROJ).find(p => p.startsWith(BUS));
  mkdirSync(BUS, { recursive: true });
  writeFileSync(marker, "cut\n");
  const before = readFileSync(path, "utf8");
  const beforeMtime = statSync(path).mtimeMs;

  const r = cli(["show", SEAT, "7002"]);
  ok("show runs with a turncut marker present", r.status === 0, r.out);
  ok("show does not rewrite the sidecar", readFileSync(path, "utf8") === before);
  ok("show does not even touch the sidecar's mtime", statSync(path).mtimeMs === beforeMtime);
  ok("show leaves the turncut marker for the real reader", existsSync(marker));

  // THE POSITIVE CONTROL. If an ordinary read did not repair here either, the three assertions
  // above would be measuring an inert fixture rather than show's restraint.
  const rr = readState(SEAT, 7002, { project: PROJ, cwd: REPO });
  ok("positive control: an ordinary read DOES recover from that same marker",
    rr.ok && rr.recovered !== null && rr.recovered.persisted, JSON.stringify(rr.recovered));
  ok("positive control: the recovering read consumed the marker", !existsSync(marker));
  ok("positive control: the recovering read cleared the stale credit",
    rr.ok && rr.state.files["lib/state/store.mjs"].verified === false);
}

// ── validate ──────────────────────────────────────────────────────────────────────────────────
{
  seed(7010, { task: "a good one" });
  const r = cli(["validate", SEAT, "7010"]);
  ok("validate exits 0 on a schema-valid sidecar", r.status === 0, r.out);
  ok("validate names the card it checked", r.out.includes("7010"), r.out);
}
{
  seedRaw(7011, "{not json at all");
  const r = cli(["validate", SEAT, "7011", "--json"]);
  const f = JSON.parse(r.out).results[0];
  ok("validate: unparseable sidecar exits non-zero", r.status === 1, String(r.status));
  ok("validate: unparseable sidecar is MIGRATE_FAILED at parse",
    f.code === "MIGRATE_FAILED" && f.at === "parse" && /not JSON/.test(f.message), JSON.stringify(f));
}
{
  seedRaw(7012, JSON.stringify({ schema_version: 99, card: 7012 }));
  const r = cli(["validate", SEAT, "7012", "--json"]);
  const f = JSON.parse(r.out).results[0];
  ok("validate: no migration path is MIGRATE_FAILED at schema_version",
    r.status === 1 && f.code === "MIGRATE_FAILED" && f.at === "schema_version", JSON.stringify(f));
}
{
  const bad = { ...emptyState(7013, SEAT), done_count: -1 };
  seedRaw(7013, JSON.stringify(bad));
  const r = cli(["validate", SEAT, "7013", "--json"]);
  const f = JSON.parse(r.out).results[0];
  ok("validate: a schema-invalid sidecar reports the field that broke",
    r.status === 1 && /done_count/.test(f.message), JSON.stringify(f));
  const plain = cli(["validate", SEAT, "7013"]);
  ok("validate prints code · at · message without --json",
    /FAIL/.test(plain.out) && /done_count/.test(plain.out) && plain.status === 1, plain.out);
}
{
  // A v2 sidecar is READ, migrated and reported as valid — validate is the read path, not a
  // stricter second opinion on it.
  seedRaw(7014, JSON.stringify({ schema_version: 2, card: 7014, task: "old shape", done: [], in_flight: [], next: [], blockers: [], files: {}, verify: {}, notes: "", ext: {}, cursor: { turn: 1, ts: 1, by: SEAT } }));
  const r = cli(["validate", SEAT, "7014", "--json"]);
  const f = JSON.parse(r.out).results[0];
  ok("validate migrates a v2 sidecar and says so", r.status === 0 && f.ok && f.migrated === true, JSON.stringify(f));
}
{
  // The sweep: no seat/card named → every sidecar in the project, and one bad one fails the run
  // without hiding the good ones.
  const r = cli(["validate", "--json"]);
  const j = JSON.parse(r.out);
  ok("validate with no card sweeps every sidecar", j.checked >= 6, r.out.slice(0, 300));
  ok("validate's sweep fails when any sidecar is bad", r.status === 1 && j.failed >= 3, `${r.status} ${j.failed}`);
  ok("validate's sweep still reports the good ones", j.results.some(x => x.ok), r.out.slice(0, 300));
  const miss = cli(["validate", SEAT, "7098"]);
  ok("validate on a missing sidecar exits non-zero", miss.status === 1, miss.out);
}

// ── reset ─────────────────────────────────────────────────────────────────────────────────────
{
  const path = seed(7020);
  const ops = opsPath(SEAT, 7020, PROJ);
  writeFileSync(ops, `${JSON.stringify({ rev: 1, op: "set" })}\n`);

  const refused = cli(["reset", SEAT, "7020"]);
  ok("reset without --force refuses off a TTY", refused.status === 2, `${refused.status} ${refused.out}`);
  ok("reset's refusal names the flag that would mean it", /--force/.test(refused.out), refused.out);
  ok("reset that refused deleted NOTHING", existsSync(path) && existsSync(ops));

  const r = cli(["reset", SEAT, "7020", "--force"]);
  ok("reset --force exits 0", r.status === 0, r.out);
  ok("reset --force removes the sidecar", !existsSync(path));
  ok("reset --force removes the ops journal beside it", !existsSync(ops));

  const again = cli(["reset", SEAT, "7020", "--force"]);
  ok("reset on nothing is a quiet no-op", again.status === 0 && /nothing to reset/.test(again.out), again.out);
}

// ── gc ────────────────────────────────────────────────────────────────────────────────────────
{
  const old = GC_AGE_MS + 86400000;
  const doneOld = seed(7030);      backdate(doneOld, old);
  const doingOld = seed(7031);     backdate(doingOld, old);
  const doneFresh = seed(7032);
  const staleOld = seed(7033);     backdate(staleOld, old);
  const failedOld = seed(7034);    backdate(failedOld, old);
  const journal = opsPath(SEAT, 7030, PROJ);
  writeFileSync(journal, "{}\n");
  const preserved = `${doneOld.slice(0, -".json".length)}.v2.json`;
  writeFileSync(preserved, "{}\n");
  setCards([
    { id: 7030, status: "done" }, { id: 7031, status: "doing" }, { id: 7032, status: "done" },
    { id: 7033, status: "stale" }, { id: 7034, status: "failed" },
  ]);

  const preview = cli(["gc"]);
  ok("gc previews without --apply", preview.status === 0, preview.out);
  ok("gc's preview lists the finished old card", preview.out.includes("7030"), preview.out);
  ok("gc's preview deletes nothing", existsSync(doneOld) && existsSync(staleOld));

  const applied = cli(["gc", "--apply", "--json"]);
  const j = JSON.parse(applied.out);
  ok("gc --apply exits 0", applied.status === 0, applied.out);
  ok("gc collects a done card past the window", !existsSync(doneOld));
  ok("gc collects a stale card past the window", !existsSync(staleOld));
  ok("gc takes the ops journal with it", !existsSync(journal));
  ok("gc takes the preserved copy with it", !existsSync(preserved));
  // The three negatives are the point: gc is a retention rule, not a broom.
  ok("gc keeps a card that is still being worked", existsSync(doingOld));
  ok("gc keeps a finished card inside the window", existsSync(doneFresh));
  ok("gc keeps a FAILED card — failed cards get bounced back to doing", existsSync(failedOld));
  ok("gc --json reports what it removed", j.applied === true && j.removed.length >= 3, applied.out.slice(0, 300));
}
{
  // The retention window is P1's, and --older only narrows the question — it never invents a
  // second copy of the 14-day rule.
  const fresh = seed(7040);
  backdate(fresh, 3 * 86400000);
  setCards([{ id: 7040, status: "done" }]);
  ok("gc leaves a 3-day-old sidecar alone at the default window",
    cli(["gc", "--apply"]).status === 0 && existsSync(fresh));
  const narrowed = cli(["gc", "--apply", "--older", "1d"]);
  ok("gc --older 1d collects it", narrowed.status === 0 && !existsSync(fresh), narrowed.out);
  ok("gc rejects a duration it cannot read", cli(["gc", "--older", "soon"]).status === 2);
}
{
  // An unreachable hub means every status is unknown, and unknown must never read as finished.
  const survivor = seed(7050);
  backdate(survivor, GC_AGE_MS + 86400000);
  const r = cli(["gc", "--apply"], { RELAY_URL: "http://127.0.0.1:1" });
  ok("gc refuses when the hub is unreachable", r.status === 1, `${r.status} ${r.out}`);
  ok("gc says why it refused", /hub/i.test(r.out) && /guess/.test(r.out), r.out);
  ok("gc deleted nothing on an unreachable hub", existsSync(survivor));
}

// ── the seam: bin/cli.mjs actually dispatches it ───────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [CLI_BIN, "state"], { encoding: "utf8", env: env(), cwd: REPO });
  ok("`trantor state` reaches bin/state.mjs through the dispatcher",
    r.status === 0 && /trantor state show <seat> <card>/.test(r.stdout || ""), (r.stdout || "") + (r.stderr || ""));
  const help = spawnSync(process.execPath, [CLI_BIN], { encoding: "utf8", env: env(), cwd: REPO });
  ok("`trantor` lists state in its own help", /trantor state\s/.test(help.stdout || ""), (help.stdout || "").slice(0, 200));
}

hub.kill();
done();
