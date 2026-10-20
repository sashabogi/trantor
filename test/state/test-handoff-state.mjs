#!/usr/bin/env node
// Trantor State P4 — the handoff path (TDD §4.5): the writer builds a state, the reader renders it,
// and neither may cost a handoff. `state` rides beside `summary` (capSummary ate STATE, #6528), and
// a state that fails validation attaches null and logs, so the baton is never lost to a shape check.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyState, stateError } from "../../lib/state/schema.mjs";
import { statePath } from "../../lib/state/store.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, ".agent-bus-out", "handoff-state-fixtures");
mkdirSync(FIXTURES, { recursive: true });

// A bus dir of our own, and a hub that is not there: resolveHandoffCard's lookup must degrade to 0
// rather than reach the real hub or hang the suite.
const BUS = mkdtempSync(join(FIXTURES, "bus-"));
process.env.AGENT_BUS_DIR = BUS;
process.env.RELAY_URL = "http://127.0.0.1:1";
delete process.env.TRANTOR_STATE_HANDOFF;
delete process.env.TRANTOR_CARD;

const { attachState, renderStateBlock, stateHandoffEnabled, resolveHandoffCard, resolveSeat } =
  await import("../../hooks/lib/handoff.mjs");

const PROJECT = "trantor";
const SEAT = "claude:trantor";
const CARD = 6909;
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

function tempRepo() {
  const dir = mkdtempSync(join(FIXTURES, "repo-"));
  git(["init", "-q", "-b", "main"], dir);
  write(join(dir, "lib", "state", "derive.mjs"), "export const a = 1;\n");
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  write(join(dir, "lib", "state", "derive.mjs"), "export const a = 2;\n");
  return dir;
}
const REPO = tempRepo();

const SUMMARY = `## TASK\nShip P4.\n\n## STATE\n- done: wrote derive.mjs @lib/state/derive.mjs\n- wiring attachState\n\n## OPEN THREADS & NEXT STEPS\n- run the suite\n`;
const record = () => ({ id: "trantor-1", project: REPO, projectName: PROJECT, summary: SUMMARY, consumed: false });
const opts = { project: PROJECT, seat: SEAT, card: CARD, worktree: REPO };

// --- the flag: dark by default ------------------------------------------------------------------
{
  ok("the flag is OFF unless set", stateHandoffEnabled({ AGENT_BUS_DIR: BUS }) === false);
  ok("TRANTOR_STATE_HANDOFF=0 is off", stateHandoffEnabled({ AGENT_BUS_DIR: BUS, TRANTOR_STATE_HANDOFF: "0" }) === false);
  ok("TRANTOR_STATE_HANDOFF=1 is on", stateHandoffEnabled({ AGENT_BUS_DIR: BUS, TRANTOR_STATE_HANDOFF: "1" }) === true);

  const rec = record();
  ok("with the flag off, attachState returns null", attachState(rec, opts) === null);
  ok("…and does not touch the record at all", !("state" in rec), JSON.stringify(Object.keys(rec)));
  ok("…leaving the prose summary exactly as it was", rec.summary === SUMMARY);
}

// --- #12069: the hooks never source ~/.agent-bus/.env, so the flag has to be read from it ----------
{
  const envFile = join(BUS, ".env");
  const bare = { AGENT_BUS_DIR: BUS };
  ok("neither process env nor file: off", stateHandoffEnabled(bare) === false);
  writeFileSync(envFile, "# crew layer\nTRANTOR_STATE_HANDOFF=1\n");
  ok("flag only in the .env file: on", stateHandoffEnabled(bare) === true);
  ok("an explicit file path is honoured", stateHandoffEnabled({}, envFile) === true);
  ok("process env 0 beats file 1", stateHandoffEnabled({ ...bare, TRANTOR_STATE_HANDOFF: "0" }) === false);
  const rec = record();
  const s = attachState(rec, { ...opts, env: { ...bare } });
  ok("a handoff written with the flag only in the file carries state", s !== null && rec.state === s, JSON.stringify(Object.keys(rec)));
  ok("master TRANTOR_STATE=0 beats the file's HANDOFF=1", stateHandoffEnabled({ ...bare, TRANTOR_STATE: "0" }) === false);
  rmSync(envFile);
  ok("file gone: off again", stateHandoffEnabled(bare) === false);
  ok("master off + HANDOFF=1 in process env => off", stateHandoffEnabled({ ...bare, TRANTOR_STATE: "off", TRANTOR_STATE_HANDOFF: "1" }) === false);
  ok("master unset + HANDOFF=1 in process env => on", stateHandoffEnabled({ ...bare, TRANTOR_STATE_HANDOFF: "1" }) === true);
}

const ON = { ...process.env, TRANTOR_STATE_HANDOFF: "1" };

// --- source 2: derived, because Phase 1 has no sidecar ------------------------------------------
{
  const rec = record();
  const s = attachState(rec, { ...opts, env: ON });
  ok("with the flag on and no sidecar, a state is DERIVED", Boolean(s) && rec.state === s, JSON.stringify(s && Object.keys(s)));
  ok("the derived state is schema-valid", stateError(s) === "", stateError(s));
  ok("it carries the handoff's own items", s.done.length === 1 && s.in_flight.length === 1 && s.next.length === 1,
    JSON.stringify({ d: s.done.length, f: s.in_flight.length, n: s.next.length }));
  ok("it carries git's touched paths", Boolean(s.files["lib/state/derive.mjs"]), JSON.stringify(s.files));
  ok("NOTHING in it is verified", Object.values(s.files).every(f => f.verified === false) && !Object.keys(s.verify).length,
    JSON.stringify({ files: s.files, verify: s.verify }));
  ok("the prose summary is untouched by any of it", rec.summary === SUMMARY);
}

// --- source 1: the sidecar wins the moment one exists (Phase 2a) --------------------------------
{
  const path = statePath(SEAT, CARD, PROJECT);
  ok("the sidecar path resolves inside the test bus dir", Boolean(path) && path.startsWith(BUS), String(path));
  const sidecar = emptyState(CARD, SEAT);
  sidecar.task = "the sidecar's own task";
  sidecar.files["lib/state/gate.mjs"] = { touched: true, verified: true, hash: "deadbeef" };
  sidecar.verify = { tested: true, exit: 0, cmd: "node test/run.mjs --only state" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sidecar)}\n`);

  const rec = record();
  const s = attachState(rec, { ...opts, env: ON });
  ok("an existing sidecar is READ, not re-derived", s.task === "the sidecar's own task", s.task);
  ok("…and its real credit survives the read", s.files["lib/state/gate.mjs"].verified === true, JSON.stringify(s.files));

  // A sidecar that is not JSON is a rejection, and a rejection must not cost the handoff.
  writeFileSync(path, "{ not json");
  const bad = record();
  ok("a corrupt sidecar attaches null", attachState(bad, { ...opts, env: ON }) === null);
  ok("…on the record too", bad.state === null);
  ok("…and the handoff still has its prose", bad.summary === SUMMARY);
  rmSync(path, { force: true });
  rmSync(`${path.slice(0, -".json".length)}.vunknown.json`, { force: true });
}

// --- attachState never throws --------------------------------------------------------------------
{
  const rec = { summary: 42, projectName: PROJECT };
  ok("a junk record attaches null instead of throwing", attachState(rec, { ...opts, env: ON, worktree: "/nonexistent" }) !== undefined);
  ok("attachState with no options at all is safe", attachState({}, { env: ON }) !== undefined);
}

// --- which card the handoff belongs to -----------------------------------------------------------
{
  ok("TRANTOR_CARD wins", resolveHandoffCard({ projectName: PROJECT, seat: SEAT, env: { TRANTOR_CARD: "6909" } }) === 6909);
  ok("a junk TRANTOR_CARD falls through", resolveHandoffCard({ projectName: PROJECT, seat: SEAT, env: { TRANTOR_CARD: "not-a-card" } }) === 0);
  ok("an unreachable hub costs the card number, not the handoff",
    resolveHandoffCard({ projectName: PROJECT, seat: SEAT, env: {} }) === 0);
  ok("the seat id is <agent>:<project>", resolveSeat(PROJECT, { RELAY_AGENT: "claude" }) === SEAT);
  ok("an explicit RELAY_SESSION wins", resolveSeat(PROJECT, { RELAY_SESSION: "glm:trantor" }) === "glm:trantor");
}

// --- the reader ------------------------------------------------------------------------------------
{
  ok("no state renders nothing", renderStateBlock(null) === "" && renderStateBlock(undefined) === "");

  const s = attachState(record(), { ...opts, env: ON });
  const block = renderStateBlock(s);
  ok("the block names the task", block.includes("Ship P4"), block);
  ok("the block lists items by id", /done \(1\): d1 wrote derive\.mjs/.test(block), block);
  ok("the block shows an item's evidence paths", block.includes("[lib/state/derive.mjs]"), block);
  ok("the block STATES the absence of credit", /NO PATH IS VERIFIED HERE/.test(block), block);
  ok("the block carries the derived notes line", /notes: derived:/.test(block), block);
  ok("the block is small enough to inject", block.length < 4096, String(block.length));

  const credited = emptyState(CARD, SEAT);
  credited.task = "real work";
  credited.files["lib/state/gate.mjs"] = { touched: true, verified: true, hash: "beef" };
  credited.verify = { tested: true, exit: 0 };
  const cb = renderStateBlock(credited);
  ok("a state with real credit does NOT carry the no-credit warning", !/NO PATH IS VERIFIED/.test(cb), cb);
  ok("…and names the verified path", cb.includes("1 verified — lib/state/gate.mjs"), cb);
  ok("…and shows the gate's verdict", cb.includes("verify: tested=true exit=0"), cb);
}

rmSync(REPO, { recursive: true, force: true });
rmSync(BUS, { recursive: true, force: true });
done();
