#!/usr/bin/env node
// trantor doctor — the contract the desktop Agents view depends on.
// The app builds one harness card per crew-section entry by splitting "<brand>: <fact>". That grammar
// is load-bearing UI, not an internal detail: when the section also carried a colon-less aggregate
// ("no crew CLIs found"), the app rendered a phantom seat named "no" where a real harness belonged.
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

// doctor exits non-zero when it finds issues, and "nothing installed" is precisely the case under
// test — so read stdout either way rather than treating a findings-exit as a harness failure.
const run = (path) => {
  const opts = { encoding: "utf8", env: { HOME: homedir(), PATH: path }, maxBuffer: 8 * 1024 * 1024 };
  try { return JSON.parse(execFileSync(process.execPath, [join(HERE, "bin", "doctor.mjs"), "--json"], opts)); }
  catch (e) { return JSON.parse(e.stdout); }
};
const crewOf = (r) => [...r.ok, ...r.issues, ...r.notes].filter(e => String(e.section || "").startsWith("crew"));
// The exact rule desktop/src/features/agents/Agents.tsx applies.
const brandsOf = (entries) => entries
  .map(e => { const i = e.message.indexOf(":"); return i > 0 ? e.message.slice(0, i).trim() : null; })
  .filter(Boolean);

console.log("\n# test-doctor — the harness grammar the Agents view parses");

// 1. A machine with seats installed: claude is one of them.
const rich = run(process.env.PATH);
const richBrands = brandsOf(crewOf(rich));
ok("claude is reported as a crew seat, not only as the orchestrator", richBrands.includes("claude"),
   `brands: ${richBrands.join(", ")}`);
ok("no brand is a bare English word from a sentence", !richBrands.some(b => ["no", "not", "none", "install"].includes(b.toLowerCase())),
   richBrands.join(", "));

// 2. A machine with NOTHING installed — the Finder-PATH case that produced the "no" card.
const bare = run("/usr/bin:/bin:/usr/sbin:/sbin");
const bareEntries = crewOf(bare);
const aggregate = bareEntries.find(e => /no crew CLIs found/.test(e.message));
ok("an empty machine still emits the aggregate warning", !!aggregate);
ok("the aggregate carries NO colon, so the view's rule can drop it", !!aggregate && !aggregate.message.includes(":"));
const bareBrands = brandsOf(bareEntries);
ok("parsing an empty machine invents no seat called 'no'", !bareBrands.includes("no"), bareBrands.join(", "));
ok("every surviving brand came from a real seat line", bareBrands.every(b => /^[a-z]/.test(b)), bareBrands.join(", "));

// 3. Key attribution. A provider key that authenticates BOTH the crew seats and Scrooge makes a
// spend spike unattributable — that is exactly how a $14 DeepSeek day (2026-08-25) took an
// investigation to explain, when Scrooge turned out to be 0.15% of the tokens on the key.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const runHome = (home) => {
    const opts = { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" }, maxBuffer: 8 * 1024 * 1024 };
    try { return JSON.parse(execFileSync(process.execPath, [join(HERE, "bin", "doctor.mjs"), "--json"], opts)); }
    catch (e) { return JSON.parse(e.stdout); }
  };
  const mkHome = (crew, scrooge, opencode) => {
    const h = mkdtempSync(join(tmpdir(), "trantor-keys-"));
    mkdirSync(join(h, ".agent-bus"), { recursive: true });
    mkdirSync(join(h, ".token-scrooge"), { recursive: true });
    if (crew !== null) writeFileSync(join(h, ".agent-bus", ".env"), crew);
    if (scrooge !== null) writeFileSync(join(h, ".token-scrooge", ".env"), scrooge);
    if (opencode) {
      mkdirSync(join(h, ".config", "opencode"), { recursive: true });
      writeFileSync(join(h, ".config", "opencode", "opencode.json"), JSON.stringify(opencode));
    }
    return h;
  };
  const keySection = (r) => [...r.ok, ...r.issues, ...r.notes].filter(e => String(e.section || "").startsWith("provider keys"));

  // (a) no crew layer at all — the seat falls through to Scrooge's key
  const SECRET = "sk-1111secretmiddle2222";
  let r = runHome(mkHome(null, `DEEPSEEK_API_KEY=${SECRET}\n`));
  let sec = keySection(r);
  ok("a crew seat falling through to Scrooge's key is reported as double duty",
    sec.some(e => /DEEPSEEK_API_KEY.*share ONE key/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…and it raises exactly ONE issue, not one per provider",
    r.issues.filter(e => String(e.section || "").startsWith("provider keys")).length === 1);
  ok("the key itself is NEVER printed in full",
    !JSON.stringify(r).includes(SECRET), "the raw key leaked into the report");
  ok("…but enough of it shows to match a line item on the provider's bill",
    sec.some(e => e.message.includes("2222")));

  // (a2) a seat whose provider config holds a LITERAL key never reads the env var, so a shared value
  // there costs nothing. Flagging it is noise — five of the first seven findings were this.
  r = runHome(mkHome(null, `ZAI_API_KEY=${SECRET}\n`, { provider: { "zai-coding-plan": { options: { apiKey: "literal-plan-key" } } } }));
  sec = keySection(r);
  ok("a provider with a LITERAL key in its own config is reported as Scrooge-only, not shared",
    sec.some(e => /ZAI_API_KEY.*Scrooge only/.test(e.message)), sec.map(e => e.message).join(" | "));

  // (a3) …but "{env:VAR}" resolves from the environment at run time, so that seat DOES read the var.
  // Conflating the two reported a correctly-split key as "no crew seat reads this var".
  r = runHome(mkHome(null, `DEEPSEEK_API_KEY=${SECRET}\n`, { provider: { deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" } } } }));
  sec = keySection(r);
  ok("an {env:…} template still counts as the seat reading the env var",
    sec.some(e => /DEEPSEEK_API_KEY.*share ONE key/.test(e.message)), sec.map(e => e.message).join(" | "));

  // (b) the crew has its OWN key — the whole point of the split
  r = runHome(mkHome(`DEEPSEEK_API_KEY=sk-9999crewkey8888\n`, `DEEPSEEK_API_KEY=${SECRET}\n`));
  sec = keySection(r);
  ok("a crew key of its own clears the double-duty finding",
    !sec.some(e => /share ONE key/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…and doctor says the two are separately billable",
    sec.some(e => /separate keys/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…naming the crew layer as the source, so precedence is legible",
    sec.some(e => /agent-bus\/\.env \(crew\)/.test(e.message)), sec.map(e => e.message).join(" | "));
}

// 4. The duty row. The fleet watcher sat dead for four days (2026-08-27→31) while everything
// else reported green — a dead watcher raises no error, it just stops nudging. The doctor must
// make every duty state loud, each with its fix.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const http = await import("node:http");
  const dutyIssues = (r) => r.issues.filter(e => String(e.section || "").startsWith("duty seat"));
  const dutyOks = (r) => r.ok.filter(e => String(e.section || "").startsWith("duty seat"));
  // A stand-in fleet hub whose duty state the drill controls per case.
  const hubState = { dutySession: "", sessions: [] };
  const fh = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname === "/overseer/status") return res.end(JSON.stringify({ dutySession: hubState.dutySession }));
    if (u.pathname === "/peers") return res.end(JSON.stringify({ sessions: hubState.sessions }));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => fh.listen(0, "127.0.0.1", r));
  const FURL = `http://127.0.0.1:${fh.address().port}`;
  const mkDutyHome = (files = {}) => {
    const h = mkdtempSync(join(tmpdir(), "trantor-duty-"));
    mkdirSync(join(h, ".agent-bus"), { recursive: true });
    writeFileSync(join(h, ".agent-bus", "config.json"), JSON.stringify({ url: FURL, ownerIdentity: "admin" }));
    for (const [p, c] of Object.entries(files)) {
      const f = join(h, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c);
    }
    return h;
  };
  // Async spawn, never spawnSync: the fake hub lives in THIS process, so a synchronous child
  // would block the event loop that has to answer the doctor's hub reads (the same trap
  // test-duty-seat.mjs documents for its mock hub).
  const runDuty = (home) => new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(HERE, "bin", "doctor.mjs"), "--json"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    let so = "";
    kid.stdout?.on?.("data", (d) => (so += d));
    kid.on("close", () => { try { resolve(JSON.parse(so)); } catch (e) { resolve({ ok: [], issues: [], notes: [], _err: String(e) }); } });
  });

  // (a) nothing anywhere — the exact state of 08-27→31
  hubState.dutySession = ""; hubState.sessions = [];
  let h = mkDutyHome();
  let r = await runDuty(h);
  ok("no duty process, no keepalive, no hub seat → nobody is watching the fleet",
    dutyIssues(r).some(e => /nobody is watching the fleet/.test(e.message)), JSON.stringify(dutyIssues(r)));
  ok("…and the fix names trantor duty up with the keepalive it installs",
    dutyIssues(r).some(e => /trantor duty up/.test(e.fix || "") && /com\.trantor\.duty/.test(e.fix || "")), JSON.stringify(dutyIssues(r).map(e => e.fix)));

  // (b) seat process up, hub beat fresh — the healthy state
  hubState.dutySession = "claude:trantor-duty";
  hubState.sessions = [{ session: "claude:trantor-duty", lastSeen: Date.now() }];
  h = mkDutyHome({ ".agent-bus/duty.pid": String(process.pid) });   // a LIVE pid: this drill process
  r = await runDuty(h);
  ok("a running seat with a fresh beat reads as running", dutyOks(r).some(e => /running \(pid/.test(e.message) && /beat just now/.test(e.message)),
    JSON.stringify(dutyOks(r)));

  // (c) process up but the hub heard nothing for 20 minutes — running deaf
  hubState.sessions = [{ session: "claude:trantor-duty", lastSeen: Date.now() - 20 * 60 * 1000 }];
  h = mkDutyHome({ ".agent-bus/duty.pid": String(process.pid) });
  r = await runDuty(h);
  ok("a live process with a stale beat is reported as running deaf",
    dutyIssues(r).some(e => /running deaf/.test(e.message)), JSON.stringify(dutyIssues(r)));

  // (d) the hub still points at a seat with no process — escalations into a hole
  hubState.sessions = [{ session: "claude:trantor-duty", lastSeen: Date.now() }];
  h = mkDutyHome();
  r = await runDuty(h);
  ok("a hub pointer with no process behind it is flagged",
    dutyIssues(r).some(e => /go into a hole/.test(e.message)), JSON.stringify(dutyIssues(r)));

  // (e) keepalive installed but the seat down — launchd should have relaunched it
  hubState.dutySession = ""; hubState.sessions = [];
  h = mkDutyHome({ "Library/LaunchAgents/com.trantor.duty.plist": "<plist><dict><key>KeepAlive</key><true/></dict></plist>" });
  r = await runDuty(h);
  ok("an installed keepalive with a dead seat accuses launchd, not silence",
    dutyIssues(r).some(e => /keepalive installed but the seat is down/.test(e.message)), JSON.stringify(dutyIssues(r)));

  fh.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
