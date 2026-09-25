#!/usr/bin/env node
// trantor — declared seats: the registry, liveness, and recovery. A reboot that reopens windows in
// $HOME un-seats the crew; seats make it recoverable. What matters here: a seat is a DECLARATION
// (never inferred), "live" means a process is standing in the seat's directory (never a name
// asserted to the hub), and recovery is bounded — never a launch job that relaunches on failure.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "trantor-seats-"));
process.env.AGENT_BUS_DIR = dir;
delete process.env.RELAY_URL;
delete process.env.RELAY_PROJECT;

const S = await import("../../lib/seats.mjs");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
// Injected everywhere liveness is pinned, so no drill ever spawns a real herdr (#8716).
const NO_HERDR = { installed: false, ok: true, agents: [] };

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
  const rows = S.seatStatus(live, NO_HERDR);
  const h = rows.find(r => r.project === "crebral-health");
  const s = rows.find(r => r.project === "crebral-scribe");
  ok("a seat with a process in its dir is live", h.live === true && h.pid === 4242);
  ok("a seat with nothing in its dir is missing", s.live === false);
  ok("…and says why, naming the agent it wants", /no claude process/.test(s.why), s.why);
  ok("a process in the WRONG dir does not count", S.seatStatus([{ pid: 9, comm: "claude", cwd: join(dir, "elsewhere") }], NO_HERDR).every(r => !r.live));
  ok("missingSeats lists exactly the missing ones", S.missingSeats(live, NO_HERDR).map(m => m.project).join() === "crebral-scribe");
}

console.log("\nA seat is held only by the agent it was declared for:");
{
  // Caught live: crebral-health reported "live (opencode 40249)" because a CREW seat was working
  // in the repo, while the operator's Claude window — the thing that actually went missing — was
  // gone. Counting another agent as the seat is a false green in the exact place this feature
  // exists to prevent one.
  const crew = [{ pid: 40249, comm: "opencode", cwd: health }];
  const row = S.seatStatus(crew, NO_HERDR).find(r => r.project === "crebral-health");
  ok("another agent in the dir does NOT hold the seat", row.live === false);
  ok("…and it is named in the reason", /opencode 40249/.test(row.why), row.why);
  ok("the seat is still offered for recovery", S.missingSeats(crew, NO_HERDR).some(m => m.project === "crebral-health"));
  S.declareSeat("crew-seat", scribe, "opencode");
  const row2 = S.seatStatus([{ pid: 7, comm: "opencode", cwd: scribe }], NO_HERDR).find(r => r.project === "crew-seat");
  ok("a seat declared for opencode IS held by opencode", row2.live === true && row2.pid === 7);
  ok("the launch command targets the declared project", S.launchSeat(S.missingSeats([], NO_HERDR).find(m => m.project === "crew-seat"), { dryRun: true }).command.endsWith("trantor open crew-seat"));
  S.undeclareSeat("crew-seat");
}

console.log("\nA seat carries its hub provenance (an unpinned seat is still a warning):");
{
  const rows = S.seatStatus([], NO_HERDR);
  ok("pinned seat reports via=pin", rows.every(r => r.via === "pin"), JSON.stringify(rows.map(r => r.via)));
  S.declareSeat("loose", wsp);
  ok("an unpinned seat reports a fallback", S.seatStatus([], NO_HERDR).find(r => r.project === "loose").via !== "pin");
  S.undeclareSeat("loose");
}

console.log("\nRecovery targets the directory, not a name:");
{
  const m = S.missingSeats([], NO_HERDR).find(x => x.project === "crebral-scribe");
  const r = S.launchSeat(m, { dryRun: true });
  ok("the command cds into the seat's own directory", r.command.includes(`cd ${JSON.stringify(scribe)}`), r.command);
  ok("dry run launches nothing", r.launched === false);
}

console.log("\nA missing seat is restored as a herdr pane, never a Terminal window (#8716):");
{
  const m = S.missingSeats([], NO_HERDR).find(x => x.project === "crebral-scribe");
  const r = S.launchSeat(m, { dryRun: true });
  ok("the launch command is trantor open, never osascript", /trantor open crebral-scribe$/.test(r.command) && !/osascript|Terminal/.test(r.command), r.command);
  const absent = S.launchSeat(m, { which: () => { throw new Error("no herdr here"); } });
  ok("herdr absent: the command is returned, nothing spawns", absent.launched === false && /trantor open/.test(absent.command), JSON.stringify(absent));
  let seen = null;
  const fakeSpawn = (file, args, opts) => { seen = { file, args, opts }; return { unref() {} }; };
  const dirty = { PATH: "/usr/bin:/bin", TRANTOR_ORCH: "orch", HERDR_PANE_ID: "w9:p9", HERDR_TAB_ID: "w9:t9", HERDR_WORKSPACE_ID: "w9", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1" };
  const whichFake = (f, a) => a[0] === "herdr" ? "/opt/herdr" : "/usr/local/bin/trantor";
  const up = S.launchSeat(m, { spawnFn: fakeSpawn, env: dirty, which: whichFake });
  ok("herdr present: it spawns trantor open in the seat's directory", up.launched === true && seen.file === "/usr/local/bin/trantor" && seen.args.join(" ") === "open crebral-scribe" && seen.opts.cwd === scribe, JSON.stringify(seen));
  ok("the spawned env carries none of the caller's session identity", ["TRANTOR_ORCH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE"].every(k => !(k in seen.opts.env)) && seen.opts.env.PATH === "/usr/bin:/bin", JSON.stringify(Object.keys(seen.opts.env)));
  const boom = S.launchSeat(m, { spawnFn: () => { throw new Error("spawn failed"); }, env: {}, which: whichFake });
  ok("a failed spawn reports the error and the command", boom.launched === false && /spawn failed/.test(boom.error ?? "") && /trantor open/.test(boom.command), JSON.stringify(boom));
}

console.log("\nUnknown is not missing (#8716):");
{
  // Caught live after a reboot: post-boot load starved lsof's 4s cwd read, the seat read MISSING,
  // and the login job opened a second Terminal orchestrator next to the herdr pane already holding
  // it. An unreadable cwd means the holder is unprovable in BOTH directions — never launch.
  const blind = [{ pid: 100, comm: "claude", cwd: null }];
  const row = S.seatStatus(blind, NO_HERDR).find(r => r.project === "crebral-health");
  ok("a process whose cwd lsof could not read leaves the seat UNKNOWN, not missing", row.state === "unknown" && row.live === false, JSON.stringify({ state: row.state, why: row.why }));
  ok("missingSeats never returns an unknown seat", S.missingSeats(blind, NO_HERDR).length === 0);
  ok("the why names the unreadable process", /could not read the cwd/.test(row.why) && /claude 100/.test(row.why), row.why);
  const other = S.seatStatus([{ pid: 101, comm: "opencode", cwd: null }], NO_HERDR).find(r => r.project === "crebral-health");
  ok("an unreadable process of a DIFFERENT agent cannot blind the seat", other.state === "missing", other.state);
  ok("…and that seat stays launchable", S.missingSeats([{ pid: 101, comm: "opencode", cwd: null }], NO_HERDR).some(m => m.project === "crebral-health"));
  const seen = S.seatStatus([{ pid: 100, comm: "claude", cwd: null }, { pid: 5, comm: "claude", cwd: health }], NO_HERDR).find(r => r.project === "crebral-health");
  ok("a readable holder still wins over a blind one", seen.state === "live" && seen.pid === 5);
  const gone = join(wsp, "crebral-gone"); mkdirSync(gone);
  S.declareSeat("crebral-gone", gone); rmSync(gone, { recursive: true });
  const goneRow = S.seatStatus(blind, NO_HERDR).find(r => r.project === "crebral-gone");
  ok("a vanished directory is not made unknown by a blind process", goneRow.state === "missing" && goneRow.why === "directory does not exist", JSON.stringify(goneRow));
  S.undeclareSeat("crebral-gone");
}

console.log("\nherdr counts as live (#8716):");
{
  const herdrOk = { installed: true, ok: true, agents: [{ agent: "claude", cwd: health, pane: "w4:p1", status: "idle" }] };
  const row = S.seatStatus([], herdrOk).find(r => r.project === "crebral-health");
  ok("a herdr pane standing in the seat's dir holds the seat", row.live === true && row.pane === "w4:p1" && row.pid === null, JSON.stringify({ state: row.state, pane: row.pane }));
  ok("a herdr-held seat is never in the missing list", S.missingSeats([], herdrOk).every(m => m.project !== "crebral-health"));
  const wrong = S.seatStatus([], { installed: true, ok: true, agents: [{ agent: "opencode", cwd: health, pane: "w4:p2", status: "idle" }] }).find(r => r.project === "crebral-health");
  ok("a herdr pane of the WRONG agent does not hold the seat", wrong.state === "missing" && wrong.live === false);
  ok("…but it is named in the why", /opencode pane w4:p2/.test(wrong.why), wrong.why);
  const elsewhere = S.seatStatus([], { installed: true, ok: true, agents: [{ agent: "claude", cwd: scribe, pane: "w4:p3", status: "idle" }] }).find(r => r.project === "crebral-health");
  ok("a herdr pane in a DIFFERENT directory does not hold the seat", elsewhere.state === "missing");
  ok("herdr not installed: plain lsof semantics, the seat is missing", S.seatStatus([], NO_HERDR).find(r => r.project === "crebral-health").state === "missing");
  const dark = { installed: true, ok: false, agents: [] };
  const darkRow = S.seatStatus([], dark).find(r => r.project === "crebral-health");
  ok("herdr installed but erroring reads UNKNOWN (a pane could be standing there)", darkRow.state === "unknown", darkRow.why);
  ok("…and missingSeats never launches on a dark herdr", S.missingSeats([], dark).length === 0);
}

console.log("\nherdrAgents parses, skips, and fails soft (#8716):");
{
  const fakeExec = (file, args) => args[0] === "herdr"
    ? "/usr/local/bin/herdr"
    : JSON.stringify({ result: { agents: [{ agent: "claude", cwd: "/tmp/h", pane_id: "w1:p1", agent_status: "idle" }] } });
  const h = S.herdrAgents(fakeExec);
  ok("parses herdr agent list into agent/cwd/pane/status", h.installed === true && h.ok === true && h.agents[0]?.agent === "claude" && h.agents[0]?.cwd === "/tmp/h" && h.agents[0]?.pane === "w1:p1" && h.agents[0]?.status === "idle", JSON.stringify(h));
  const h2 = S.herdrAgents(() => { throw new Error("ENOENT"); });
  ok("herdr not installed is SKIP, not error", h2.installed === false && h2.ok === true && h2.agents.length === 0, JSON.stringify(h2));
  const garbage = (f, a) => a[0] === "herdr" ? "/usr/local/bin/herdr" : "not json at all";
  const h3 = S.herdrAgents(garbage);
  ok("unparseable herdr output reads installed-but-dark", h3.installed === true && h3.ok === false, JSON.stringify(h3));
  const noAgents = (f, a) => a[0] === "herdr" ? "/usr/local/bin/herdr" : JSON.stringify({ result: {} });
  ok("a herdr answer without an agents array reads dark too", S.herdrAgents(noAgents).ok === false);
  const dying = (f, a) => { if (a[0] === "herdr") return "/usr/local/bin/herdr"; throw new Error("timed out"); };
  ok("a herdr invocation that throws reads dark", S.herdrAgents(dying).ok === false);
}

console.log("\nThe login job waits for herdr, bounded (#8716):");
{
  let calls = 0;
  const flaky = () => { calls++; return calls < 3 ? { installed: true, ok: false, agents: [] } : { installed: true, ok: true, agents: [{ agent: "claude", cwd: health, pane: "w4:p1", status: "idle" }] }; };
  const w = await S.waitForHerdr({ timeoutMs: 1000, everyMs: 1, probe: flaky });
  ok("polls until herdr answers", w.ok === true && calls === 3, `calls=${calls}`);
  let darkCalls = 0;
  const dark = () => { darkCalls++; return { installed: true, ok: false, agents: [] }; };
  const w2 = await S.waitForHerdr({ timeoutMs: 40, everyMs: 10, probe: dark });
  ok("a herdr that never answers gives up inside the window, still dark", w2.installed === true && w2.ok === false && darkCalls >= 2, `calls=${darkCalls}`);
  let absentCalls = 0;
  const absent = () => { absentCalls++; return { installed: false, ok: true, agents: [] }; };
  const w3 = await S.waitForHerdr({ timeoutMs: 30000, everyMs: 1, probe: absent });
  ok("no herdr installed: no waiting at all", w3.installed === false && absentCalls === 1, `calls=${absentCalls}`);
  let okCalls = 0;
  const fine = () => { okCalls++; return { installed: true, ok: true, agents: [] }; };
  await S.waitForHerdr({ timeoutMs: 1000, everyMs: 1, probe: fine });
  ok("a herdr that answers at once is probed exactly once", okCalls === 1);
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
