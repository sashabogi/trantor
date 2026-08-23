#!/usr/bin/env node
// trantor — declared seats: the registry, liveness, and recovery.
//
// A session's identity is positional, so a reboot that reopens windows in $HOME un-seats the whole
// crew (2026-08-23). 0.17.81 made that loud; seats make it recoverable. What matters here is that
// a seat is a DECLARATION (never inferred), that "live" means a process is standing in the seat's
// directory (never a name asserted to the hub), and that recovery is bounded — the machine already
// went to load 490 once because a launchd job relaunched a failing command every 10 seconds.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "trantor-seats-"));
process.env.AGENT_BUS_DIR = dir;
delete process.env.RELAY_URL;
delete process.env.RELAY_PROJECT;

const S = await import("./lib/seats.mjs");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor seats drill");

const wsp = join(dir, "ws"); mkdirSync(wsp, { recursive: true });
const health = join(wsp, "crebral-health"); mkdirSync(health, { recursive: true });
const scribe = join(wsp, "crebral-scribe"); mkdirSync(scribe, { recursive: true });
for (const d of [health, scribe]) spawnSync("git", ["init", "-q"], { cwd: d });
writeFileSync(join(dir, "config.json"), JSON.stringify({
  url: "http://127.0.0.1:4477",
  hubs: { "crebral-health": "http://remote:4477", "crebral-scribe": "http://remote:4477" },
}));

console.log("\nA seat is declared, never inferred:");
ok("no seats to start with", Object.keys(S.readSeats()).length === 0);
S.declareSeat("crebral-health", health);
ok("declaring one stores its directory", S.readSeats()["crebral-health"]?.dir === health);
ok("the hub pins are untouched", JSON.parse(spawnSync("cat", [join(dir, "config.json")], { encoding: "utf8" }).stdout).hubs["crebral-health"] === "http://remote:4477");
{ let threw = false; try { S.declareSeat("ghost", join(dir, "nope")); } catch { threw = true; } ok("a directory that does not exist is refused", threw); }

console.log("\nLiveness means a process is STANDING IN the directory:");
S.declareSeat("crebral-scribe", scribe);
{
  const live = [{ pid: 4242, comm: "claude", cwd: health }];
  const rows = S.seatStatus(live);
  const h = rows.find(r => r.project === "crebral-health");
  const s = rows.find(r => r.project === "crebral-scribe");
  ok("a seat with a process in its dir is live", h.live === true && h.pid === 4242);
  ok("a seat with nothing in its dir is missing", s.live === false);
  ok("…and says why, naming the agent it wants", /no claude process/.test(s.why), s.why);
  ok("a process in the WRONG dir does not count", S.seatStatus([{ pid: 9, comm: "claude", cwd: join(dir, "elsewhere") }]).every(r => !r.live));
  ok("missingSeats lists exactly the missing ones", S.missingSeats(live).map(m => m.project).join() === "crebral-scribe");
}

console.log("\nA seat is held only by the agent it was declared for:");
{
  // Caught live on 2026-08-23: crebral-health reported "live (opencode 40249)" because a CREW seat
  // was working in the repo, while the operator's Claude window — the thing that actually went
  // missing — was gone. Counting another agent as the seat is a false green in the exact place
  // this feature exists to prevent one.
  const crew = [{ pid: 40249, comm: "opencode", cwd: health }];
  const row = S.seatStatus(crew).find(r => r.project === "crebral-health");
  ok("another agent in the dir does NOT hold the seat", row.live === false);
  ok("…and it is named in the reason", /opencode 40249/.test(row.why), row.why);
  ok("the seat is still offered for recovery", S.missingSeats(crew).some(m => m.project === "crebral-health"));
  S.declareSeat("crew-seat", scribe, "opencode");
  const row2 = S.seatStatus([{ pid: 7, comm: "opencode", cwd: scribe }]).find(r => r.project === "crew-seat");
  ok("a seat declared for opencode IS held by opencode", row2.live === true && row2.pid === 7);
  ok("launch uses the seat's own agent", S.launchSeat(S.missingSeats([]).find(m => m.project === "crew-seat"), { dryRun: true }).command.endsWith("&& opencode"));
  S.undeclareSeat("crew-seat");
}

console.log("\nA seat carries its hub provenance (an unpinned seat is still a warning):");
{
  const rows = S.seatStatus([]);
  ok("pinned seat reports via=pin", rows.every(r => r.via === "pin"), JSON.stringify(rows.map(r => r.via)));
  S.declareSeat("loose", wsp);
  ok("an unpinned seat reports a fallback", S.seatStatus([]).find(r => r.project === "loose").via !== "pin");
  S.undeclareSeat("loose");
}

console.log("\nRecovery targets the directory, not a name:");
{
  const m = S.missingSeats([]).find(x => x.project === "crebral-scribe");
  const r = S.launchSeat(m, { dryRun: true });
  ok("the command cds into the seat's own directory", r.command.includes(`cd ${JSON.stringify(scribe)}`), r.command);
  ok("dry run launches nothing", r.launched === false);
}

console.log("\nSuggestions come from the pins, and are only suggestions:");
{
  S.undeclareSeat("crebral-health"); S.undeclareSeat("crebral-scribe");
  const sug = S.suggestSeats(wsp);
  ok("finds both pinned projects present on disk", sug.length === 2, JSON.stringify(sug));
  ok("suggesting does NOT declare", Object.keys(S.readSeats()).length === 0);
}

console.log("\nUndeclare:");
S.declareSeat("crebral-health", health);
ok("removing returns true when it existed", S.undeclareSeat("crebral-health") === true);
ok("…and false when it did not", S.undeclareSeat("crebral-health") === false);

console.log("\nFail-open (this runs in a CLI and a login agent — never throw):");
writeFileSync(join(dir, "config.json"), "{ not json");
ok("corrupt config yields no seats, no throw", Object.keys(S.readSeats()).length === 0);
writeFileSync(join(dir, "config.json"), JSON.stringify({ seats: "garbage" }));
ok("a non-object seats map is ignored", Object.keys(S.readSeats()).length === 0);
writeFileSync(join(dir, "config.json"), JSON.stringify({ seats: { ok: { dir: health }, bad: { nodir: 1 } } }));
ok("a malformed seat entry is dropped, good ones survive", Object.keys(S.readSeats()).join() === "ok");

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? "✅" : "❌"} seats: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
