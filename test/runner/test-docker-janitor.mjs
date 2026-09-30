#!/usr/bin/env node
// #9778 drill — the stale-resource janitor's docker half. Every docker interaction is an injected
// exec: this test never starts a real container and never calls the real docker.
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listContainers, newContainers, loadContainers, recordContainers,
  stopContainers, sweep,
} from "../../lib/docker-janitor.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`);
  if (cond) pass++; else fail++;
};

const TMP = mkdtempSync(join(tmpdir(), "docker-janitor-"));
const STATE = join(TMP, "docker-kimi-trantor.json");
// An exec that records its args and answers from a script. Never the real docker.
const fakeExec = (script) => {
  const calls = [];
  const exec = (args) => { calls.push(args); return script(args); };
  exec.calls = calls;
  return exec;
};
const psOut = (rows) => ({ status: 0, stdout: rows.map(([id, name]) => `${id} ${name}`).join("\n") + "\n" });

console.log("# docker-janitor — snapshot, record, stop (#9778)");

console.log("\n## docker ps parses; docker absent reads as null, never as empty");
{
  const exec = fakeExec(() => psOut([["a1b2", "supabase_db_proj"], ["c3d4", "supabase_kong_proj"]]));
  const list = listContainers(exec);
  ok("ps output parses to id+name rows", list.length === 2 && list[0].id === "a1b2" && list[0].name === "supabase_db_proj", JSON.stringify(list));
  ok("the exec ran exactly docker ps with the contract format",
    exec.calls.length === 1 && exec.calls[0].join(" ") === "ps --format {{.ID}} {{.Names}}", JSON.stringify(exec.calls));
  ok("docker absent (spawn error) → null", listContainers(fakeExec(() => ({ error: new Error("spawn docker ENOENT"), status: null }))) === null);
  ok("docker throwing → null", listContainers(fakeExec(() => { throw new Error("ENOENT"); })) === null);
  ok("daemon down (nonzero exit) → null", listContainers(fakeExec(() => ({ status: 1, stdout: "", stderr: "Cannot connect" }))) === null);
  ok("docker up with nothing running → []", Array.isArray(listContainers(fakeExec(() => ({ status: 0, stdout: "" })))) && listContainers(fakeExec(() => ({ status: 0, stdout: "" }))).length === 0);
}

console.log("\n## newContainers diffs by id; an unobservable side diffs to nothing");
{
  const before = [{ id: "a1b2", name: "old" }];
  const after = [{ id: "a1b2", name: "old" }, { id: "e5f6", name: "new_stack_db" }];
  const diff = newContainers(before, after);
  ok("only the genuinely new container is returned", diff.length === 1 && diff[0].id === "e5f6", JSON.stringify(diff));
  ok("a null before (docker absent at turn start) accuses nobody", newContainers(null, after).length === 0);
  ok("a null after (docker died mid-turn) accuses nobody", newContainers(before, null).length === 0);
  ok("identical snapshots diff empty", newContainers(before, before).length === 0);
}

console.log("\n## recordContainers persists against the card and dedupes by id");
{
  const added = recordContainers({ path: STATE, card: 9778, containers: [{ id: "e5f6", name: "supabase_db_proj" }, { id: "a9b0", name: "supabase_kong_proj" }], now: 1000 });
  ok("both new containers are recorded", added.length === 2, JSON.stringify(added));
  const state = loadContainers(STATE);
  ok("the state file keys containers by card", (state.cards["9778"] || []).length === 2, JSON.stringify(state));
  const again = recordContainers({ path: STATE, card: 9778, containers: [{ id: "e5f6", name: "supabase_db_proj" }], now: 2000 });
  ok("a container a second turn also saw new is recorded once", again.length === 0 && loadContainers(STATE).cards["9778"].length === 2);
  recordContainers({ path: STATE, card: 9779, containers: [{ id: "c1d2", name: "other_stack_db" }], now: 3000 });
  ok("a second card gets its own record", loadContainers(STATE).cards["9779"].length === 1);
  ok("an empty turn writes nothing", recordContainers({ path: join(TMP, "never.json"), card: 1, containers: [] }).length === 0 && !existsSync(join(TMP, "never.json")));
  ok("card 0 (no card bound) still records, keyed 0", recordContainers({ path: join(TMP, "c0.json"), card: 0, containers: [{ id: "z9", name: "kickoff_pg" }] }).length === 1 && loadContainers(join(TMP, "c0.json")).cards["0"].length === 1);
}

console.log("\n## stopContainers runs docker stop ONLY — never rm, never volumes");
{
  const exec = fakeExec(() => ({ status: 0, stdout: "e5f6\na9b0\n" }));
  const r = stopContainers({ exec, containers: [{ id: "e5f6", name: "supabase_db_proj" }, { id: "a9b0", name: "supabase_kong_proj" }] });
  ok("the verb is stop, the args are exactly the ids",
    exec.calls.length === 1 && exec.calls[0][0] === "stop" && exec.calls[0].slice(1).join(",") === "e5f6,a9b0", JSON.stringify(exec.calls));
  ok("no rm, no -v, no volume anywhere in the call", !/rm|-v|volume|prune|down/.test(exec.calls[0].join(" ")), exec.calls[0].join(" "));
  ok("stopped names come back for the bus line", r.stopped.join(",") === "supabase_db_proj,supabase_kong_proj" && r.failed.length === 0, JSON.stringify(r));
  ok("docker absent → unavailable, nothing stopped", stopContainers({ exec: fakeExec(() => ({ error: new Error("ENOENT") })), containers: [{ id: "x", name: "x" }] }).unavailable === true);
  const failing = stopContainers({ exec: fakeExec(() => ({ status: 1, stdout: "", stderr: "No such container" })), containers: [{ id: "x", name: "gone" }] });
  ok("a failed stop names what failed and stops nothing", !failing.unavailable && failing.stopped.length === 0 && failing.failed.join(",") === "gone", JSON.stringify(failing));
  ok("nothing recorded means docker is never even called", (() => { const e = fakeExec(() => ({ status: 0, stdout: "" })); stopContainers({ exec: e, containers: [] }); return e.calls.length === 0; })());
}

console.log("\n## sweep stops one card (or all), forgets what stopped, skips silently without docker");
{
  const exec = fakeExec(() => ({ status: 0, stdout: "e5f6\na9b0\n" }));
  const r = sweep({ path: STATE, exec, card: 9778 });
  ok("a card-scoped sweep stops exactly that card's containers", r.stopped.length === 2 && !r.skipped, JSON.stringify(r));
  const left = loadContainers(STATE);
  ok("stopped containers leave the record; the other card's stay", !left.cards["9778"] && (left.cards["9779"] || []).length === 1, JSON.stringify(left));
  const absent = sweep({ path: STATE, exec: fakeExec(() => { throw new Error("ENOENT"); }), card: 9779 });
  ok("docker absent → skipped, and the record stands for the next sweep", absent.skipped === true && loadContainers(STATE).cards["9779"].length === 1);
  const rest = sweep({ path: STATE, exec: fakeExec(() => ({ status: 0, stdout: "c1d2\n" })) });
  ok("an unscoped sweep takes every remaining card", rest.stopped.join(",") === "other_stack_db", JSON.stringify(rest));
  ok("an emptied record deletes its file", !existsSync(STATE));
  ok("an empty record never calls docker", (() => { const e = fakeExec(() => ({ status: 0, stdout: "" })); const rr = sweep({ path: STATE, exec: e }); return e.calls.length === 0 && rr.stopped.length === 0 && !rr.skipped; })());
  const partial = join(TMP, "partial.json");
  writeFileSync(partial, JSON.stringify({ cards: { "1": [{ id: "ok1", name: "kept_pg" }, { id: "bad1", name: "stuck_pg" }] } }));
  const pr = sweep({ path: partial, exec: fakeExec(() => ({ status: 0, stdout: "ok1\n" })) });
  ok("a container docker did not confirm stays recorded for next time",
    pr.stopped.join(",") === "kept_pg" && pr.failed.join(",") === "stuck_pg" && (loadContainers(partial).cards["1"] || []).map(c => c.id).join(",") === "bad1", JSON.stringify(pr));
}

console.log("\n## the runner and the down path are wired");
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const runner = readFileSync(join(root, "bin", "crew-runner.mjs"), "utf8");
  ok("the runner still PARSES (an unescaped backtick in the RULES template reads as lint noise, not the syntax error it is)",
    spawnSync(process.execPath, ["--check", join(root, "bin", "crew-runner.mjs")], { encoding: "utf8" }).status === 0);
  ok("the runner imports the janitor lib", /from "\.\.\/lib\/docker-janitor\.mjs"/.test(runner));
  ok("the runner snapshots docker at turn start and end", (runner.match(/listContainers\(\)/g) || []).length >= 2);
  ok("new containers are recorded against the seat's card", /recordContainers\(\{ path: DOCKERF, card: sessionCard \|\| 0/.test(runner));
  ok("a card reaching testing/done sweeps its containers", /task\.status === "testing" \|\| task\.status === "done"/.test(runner));
  ok("a park sweeps the seat's containers", /janitorStop\(`seat parked/.test(runner));
  ok("the crew RULES carry the stop-before-testing line", /stop them before moving your card to testing and name them in the note/.test(runner));
  const down = readFileSync(join(root, "bin", "crew", "state.mjs"), "utf8");
  ok("trantor down <seat> sweeps the seat's recorded containers", /dockerSweep\(\{ path: dockerStatePathFor\(agent, project\) \}\)/.test(down));
  ok("the down sweep respects CREW_NO_PROC_KILL and dry runs", /ctx\.dry \|\| ctx\.env\?\.CREW_NO_PROC_KILL === "1"/.test(down));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
