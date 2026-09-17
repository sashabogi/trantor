#!/usr/bin/env node
// trantor harvest/sync drill (#7748): a seat commit landed on main under a new sha diverges the
// seat branch. A receipt lets `trantor sync` realign it; an unreceipted commit makes it refuse.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ""}`); }
};
console.log("# trantor harvest/sync drill");

const updates = [];
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const P = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && P === "/task/update") { try { updates.push(JSON.parse(buf)); } catch {} }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, messages: [], cursor: 0 }));
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

const root = mkdtempSync(join(tmpdir(), "trantor-harvest-"));
const home = join(root, "home"), bus = join(home, ".agent-bus");
mkdirSync(bus, { recursive: true });
const project = "hv-proj";
const env = drillEnv({ HOME: home, AGENT_BUS_DIR: bus, RELAY_URL: HUB, RELAY_PROJECT: project });

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return String(r.stdout || "").trim();
}
// spawn, not spawnSync: the mock hub lives in this process and must keep answering while the CLI runs
function cli(file, args, cwd) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [join(process.cwd(), "bin", file), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    let out = "";
    c.stdout.on("data", d => (out += d)); c.stderr.on("data", d => (out += d));
    c.on("close", code => resolve({ code, out }));
  });
}
const commit = (cwd, file, msg) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

// origin + the orchestrator's checkout, exactly as the runner lays a seat out: a worktree on seat/<agent>
const origin = join(root, "origin.git");
mkdirSync(origin); git(origin, ["init", "-q", "--bare", "-b", "main"]);
const repo = join(root, "checkout");
mkdirSync(repo); git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.test"]); git(repo, ["config", "user.name", "T"]);
git(repo, ["remote", "add", "origin", origin]);
commit(repo, "README.md", "init");
git(repo, ["push", "-q", "-u", "origin", "main"]);
const seatDir = join(bus, "worktrees", project, "codex");
mkdirSync(join(bus, "worktrees", project), { recursive: true });
git(repo, ["worktree", "add", "-q", "--no-track", "-B", "seat/codex", seatDir, "HEAD"]);
git(seatDir, ["config", "branch.seat/codex.base", "main"]);
const receipts = join(bus, `harvest-${project}.json`);
const readReceipts = () => { try { return JSON.parse(readFileSync(receipts, "utf8")).receipts; } catch { return []; } };

console.log("\nA harvested commit syncs clean, receipt on disk and on the card:");
{
  const a = commit(seatDir, "a.txt", "seat lands a");
  commit(repo, "main.txt", "main moves on");
  git(repo, ["cherry-pick", a]);
  const aMain = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "-q", "origin", "main"]);
  ok("the cherry-pick is a new sha", aMain !== a);

  const h = await cli("harvest.mjs", [a.slice(0, 7), aMain.slice(0, 7), "--card", "42"], repo);
  ok("harvest exits 0 and reports the note", h.code === 0 && /card #42 noted/.test(h.out), h.out);
  const rec = readReceipts();
  ok("one receipt: seat sha -> main sha, card 42, on seat/codex",
    rec.length === 1 && rec[0].seat === a && rec[0].main === aMain && rec[0].card === 42 && rec[0].branch === "seat/codex",
    JSON.stringify(rec));
  const note = updates.find(u => Number(u.id) === 42);
  ok("card 42 got the note 'harvested <seat> as <main>'", note?.note === `harvested ${a.slice(0, 7)} as ${aMain.slice(0, 7)}`, JSON.stringify(updates));

  const dry = await cli("sync.mjs", ["--dry-run", "--no-fetch"], seatDir);
  ok("dry-run from inside the worktree names the move and touches nothing",
    dry.code === 0 && /\[dry\]/.test(dry.out) && git(seatDir, ["rev-parse", "HEAD"]) === a, dry.out);

  const s = await cli("sync.mjs", ["codex"], repo);
  ok("sync codex exits 0", s.code === 0, s.out);
  ok("the seat branch now sits on origin/main", git(seatDir, ["rev-parse", "HEAD"]) === aMain);
  ok("still on seat/codex", git(seatDir, ["rev-parse", "--abbrev-ref", "HEAD"]) === "seat/codex");
  ok("the harvested file is still there", existsSync(join(seatDir, "a.txt")));
  const again = await cli("sync.mjs", ["codex", "--no-fetch"], repo);
  ok("a second sync is a no-op", again.code === 0 && /already at/.test(again.out), again.out);
}

console.log("\nAn unharvested commit makes sync refuse and name it:");
{
  const b = commit(seatDir, "b.txt", "seat lands b unharvested");
  const s = await cli("sync.mjs", ["codex", "--no-fetch"], repo);
  ok("sync exits 1", s.code === 1, s.out);
  ok("the refusal names the commit", s.out.includes(b.slice(0, 7)) && s.out.includes("seat lands b unharvested"), s.out);
  ok("the seat branch did not move", git(seatDir, ["rev-parse", "HEAD"]) === b);
  ok("the file is still there", existsSync(join(seatDir, "b.txt")));

  // harvested afterwards, with an uncommitted edit riding along
  commit(repo, "main2.txt", "main moves on again");
  git(repo, ["cherry-pick", b]);
  const bMain = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "-q", "origin", "main"]);
  const h = await cli("harvest.mjs", [b, bMain, "--seat", "codex"], repo);
  ok("harvest without --card exits 0 and posts no note", h.code === 0 && updates.length === 1, h.out);
  writeFileSync(join(seatDir, "wip.txt"), "uncommitted\n");
  const s2 = await cli("sync.mjs", ["codex"], repo);
  ok("sync exits 0 once the receipt exists", s2.code === 0, s2.out);
  ok("the seat branch sits on origin/main", git(seatDir, ["rev-parse", "HEAD"]) === bMain);
  ok("the uncommitted edit rode along", readFileSync(join(seatDir, "wip.txt"), "utf8") === "uncommitted\n");
}

console.log("\nBad input never writes a receipt:");
{
  const before = readReceipts().length;
  const h = await cli("harvest.mjs", ["nothex", "alsonot"], repo);
  ok("harvest with a bad sha exits 1", h.code === 1, h.out);
  ok("no receipt written", readReceipts().length === before);
  const s = await cli("sync.mjs", ["nobody", "--no-fetch"], repo);
  ok("sync of an unknown seat exits 1", s.code === 1 && /no worktree/.test(s.out), s.out);
}

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} crew harvest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
