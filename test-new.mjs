#!/usr/bin/env node
// Project genesis drill (#5862): `trantor new` in all three start-from modes — plain init,
// clone --from, and --adopt — against a REAL throwaway hub, plus the guarded refusals (occupied
// dir without --adopt, missing brief file). Asserts the DIRECTORY facts (git branch, CLAUDE.md
// seeding, hook install), the HUB facts (brief posted, "genesis:" card on the new board), and
// the --json contract ({name, parent, dir, branch, hub, card}).
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor new — project genesis drill");

const W = mkdtempSync(join(tmpdir(), "trantor-new-"));
const DEV = join(W, "dev");
mkdirSync(DEV, { recursive: true });
mkdirSync(join(W, ".agent-bus"), { recursive: true });
writeFileSync(join(W, ".agent-bus", "autonomy.json"), JSON.stringify({
  version: 1,
  defaults: { harness: "bypass" },
  projects: { inherited: { harness: "bypass" } },
}));
const PORT = 47877, HUB = `http://127.0.0.1:${PORT}`;

const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...process.env, RELAY_DATA_DIR: W, HOME: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
hub._stderr = "";
hub.stderr.on("data", d => { hub._stderr += String(d); });
let hubUp = false;
for (let i = 0; i < 50; i++) {
  if (hub.exitCode !== null) { console.error("hub exited early:", hub._stderr); process.exit(1); }
  try { const r = await fetch(`${HUB}/health`); if (r.ok) { hubUp = true; break; } } catch {}
  await sleep(100);
}
ok("throwaway hub is up", hubUp);

const childEnv = (extra = {}) => ({
  ...process.env, HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"),
  RELAY_URL: HUB, TRANTOR_DEV_ROOT: DEV, RELAY_SESSION: "genesis-test",
  TRANTOR_NO_UPDATE_CHECK: "1", ...extra,
});
const runNew = (args, env = {}) => spawnSync("node", [join(ROOT, "bin", "new.mjs"), ...args], {
  encoding: "utf8", cwd: W, env: childEnv(env),
});

const BRIEF = "Genesis drill project: prove `trantor new` stands a project up in one command.";
const briefFile = join(W, "brief.md");
writeFileSync(briefFile, BRIEF);

// ── mode 1: plain init ──────────────────────────────────────────────────────────────────────────
const a = runNew(["genesis-a", "--brief", briefFile, "--json"]);
ok("init: exit 0", a.status === 0, `status ${a.status}: ${a.stderr.slice(-200)}`);
let aJson = null;
try { aJson = JSON.parse(a.stdout); } catch {}
ok("init: --json shape", !!aJson && aJson.name === "genesis-a" && aJson.branch === "main" && aJson.dir === join(DEV, "genesis-a") && Number.isInteger(aJson.card), JSON.stringify(aJson));
ok("init: hub in json is the test hub", !!aJson && aJson.hub === HUB);
ok("init: CLAUDE.md carries the brief verbatim", existsSync(aJson.dir) && readFileSync(join(aJson.dir, "CLAUDE.md"), "utf8").includes(BRIEF));
ok("init: CLAUDE.md carries the conventions block", readFileSync(join(aJson.dir, "CLAUDE.md"), "utf8").includes("## Trantor conventions"));
ok("init: auto-card hook installed", readFileSync(join(aJson.dir, ".git", "hooks", "post-commit"), "utf8").includes("trantor auto-card"));
ok("init: git branch is main", aJson?.branch === "main");
const autonomy = JSON.parse(readFileSync(join(W, ".agent-bus", "autonomy.json"), "utf8"));
ok("init: fresh project pins its harness dial to prompt", autonomy.projects?.["genesis-a"]?.harness === "prompt");
ok("init: another project's bypass dial stays untouched", autonomy.projects?.inherited?.harness === "bypass");

const tasksA = await (await fetch(`${HUB}/tasks?project=genesis-a`)).json();
const cardA = (tasksA.tasks ?? []).find(t => t.title === "genesis: genesis-a");
ok("init: genesis card on the new board", !!cardA, JSON.stringify(tasksA).slice(0, 200));
const projectsA = await (await fetch(`${HUB}/projects`)).json();
ok("init: brief posted to the hub", JSON.stringify(projectsA).includes("Genesis drill project"));
// #6068: the genesis session is a brief-poster, not an agent — its peer row must say kind
// "tool" so the app's seat strip skips it instead of rendering a "start it with trantor up"
// ghost seat.
const peersA = await (await fetch(`${HUB}/peers`)).json();
const genesisRow = (peersA.peers ?? []).find(p => p.project === "genesis-a");
ok("init: the brief-poster's peer row wears kind tool, not an agent seat", !!genesisRow && genesisRow.kind === "tool", JSON.stringify(peersA).slice(0, 200));
// the pin (#5862 residual): the first session must not wear the "not pinned to a hub" warning
const cfg = JSON.parse(readFileSync(join(W, ".agent-bus", "config.json"), "utf8"));
ok("init: project pinned to the hub it posted to", cfg.hubs?.["genesis-a"] === HUB, JSON.stringify(cfg.hubs ?? {}));

// ── mode 2: clone --from ────────────────────────────────────────────────────────────────────────
const src = join(W, "src-repo");
mkdirSync(src, { recursive: true });
writeFileSync(join(src, "seed.txt"), "cloned seed\n");
const git = (args) => spawnSync("git", args, { cwd: src, encoding: "utf8" });
git(["init", "-b", "main"]);
git(["add", "."]);
git(["-c", "user.email=drill@trantor", "-c", "user.name=drill", "commit", "-m", "seed"]);
const b = runNew(["genesis-b", "--from", src, "--json"]);
ok("clone: exit 0", b.status === 0, `status ${b.status}: ${b.stderr.slice(-200)}`);
let bJson = null;
try { bJson = JSON.parse(b.stdout); } catch {}
ok("clone: dir carries the cloned file", !!bJson && readFileSync(join(bJson.dir, "seed.txt"), "utf8").includes("cloned seed"));
ok("clone: branch is the clone's main", bJson?.branch === "main");
ok("clone: hook + CLAUDE.md still land", !!bJson && readFileSync(join(bJson.dir, "CLAUDE.md"), "utf8").includes("## Trantor conventions") && readFileSync(join(bJson.dir, ".git", "hooks", "post-commit"), "utf8").includes("trantor auto-card"));

// ── mode 3: --adopt ─────────────────────────────────────────────────────────────────────────────
const adoptDir = join(DEV, "genesis-c");
mkdirSync(adoptDir, { recursive: true });
writeFileSync(join(adoptDir, "existing.txt"), "operator work\n");
const c = runNew(["genesis-c", "--adopt", "--json"]);
ok("adopt: exit 0", c.status === 0, `status ${c.status}: ${c.stderr.slice(-200)}`);
ok("adopt: operator file untouched", existsSync(join(adoptDir, "existing.txt")));
ok("adopt: conventions appended, existing CLAUDE.md respected", existsSync(join(adoptDir, "CLAUDE.md")) === false || readFileSync(join(adoptDir, "CLAUDE.md"), "utf8").includes("## Trantor conventions"));

// ── refusals ────────────────────────────────────────────────────────────────────────────────────
const r1 = runNew(["genesis-c"]);
ok("refusal: occupied dir without --adopt exits non-zero", r1.status !== 0);
ok("refusal: the error names the directory and the way out", (r1.stderr || "").includes("--adopt"));

const r2 = runNew(["genesis-d", "--brief", join(W, "no-such-brief.md")]);
ok("refusal: missing brief file exits non-zero", r2.status !== 0);
ok("refusal: nothing was created for the refused run", !existsSync(join(DEV, "genesis-d")));

// ── the --dir contract: it is a PARENT, never the project directory itself ───────────────────────
// #6050: `--dir P` must create P/<name>, not P, and never P/P.
const ALT = join(W, "alt-dev");
mkdirSync(ALT, { recursive: true });
const d = runNew(["genesis-e", "--dir", ALT, "--json"]);
ok("parent: exit 0", d.status === 0, `status ${d.status}: ${d.stderr.slice(-200)}`);
let dJson = null;
try { dJson = JSON.parse(d.stdout); } catch {}
ok("parent: --dir P yields dir P/<name>, never P", !!dJson && dJson.dir === join(ALT, "genesis-e"), JSON.stringify(dJson));
ok("parent: json carries the parent explicitly", !!dJson && dJson.parent === ALT, JSON.stringify(dJson));
ok("parent: the project directory exists under the parent", !!dJson && existsSync(join(ALT, "genesis-e")));
ok("parent: nothing was created AT the parent path itself", !existsSync(join(ALT, ".git")) && dJson?.dir !== ALT);
ok("parent: CLAUDE.md seeded in the created dir", !!dJson && readFileSync(join(ALT, "genesis-e", "CLAUDE.md"), "utf8").includes("## Trantor conventions"));

// ── #6049: genesis on an ENFORCE hub enrolls via an owner invite, and signs its posts ───────────
// Regression for the drill that shipped nothing: `trantor new` enrolled the brand-new genesis
// identity by TOFU only, which a remote enforce hub refuses ("tofu enrollment refused") — so the
// identity stayed UNKNOWN and the signed /project POST 401'd with a swallowed reason. The fix
// enrolls like a crew seat (owner key mints a project-scoped write invite; the genesis identity
// spends it). This fake hub plays enforce (/peer 401 for the unknown genesis identity, /invite +
// /enroll succeed) and records every signed request so the test asserts the enrollment call AND
// the signature headers on the brief/card posts.
{
  const FW = mkdtempSync(join(tmpdir(), "trantor-new-enforce-"));
  const bus = join(FW, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  const keys = join(bus, "keys");
  mkdirSync(keys, { recursive: true });
  // A fake OWNER identity the genesis CLI can mint invites with (same shape loadIdentity reads).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = (k) => Buffer.from(k.export({ format: "jwk" }).d || k.export({ format: "jwk" }).x, "base64url").toString("hex");
  writeFileSync(join(keys, "drill-owner.json"), JSON.stringify({
    name: "drill-owner", kind: "agent",
    pubkey: hex(publicKey), privkey: hex(privateKey), createdAt: Date.now(),
  }));
  writeFileSync(join(bus, "config.json"), JSON.stringify({ ownerIdentity: "drill-owner" }));
  writeFileSync(join(bus, "autonomy.json"), JSON.stringify({ version: 1, defaults: { harness: "bypass" }, projects: {} }));

  const recorded = [];
  let inviteToken = "invite-token";
  const FPORT = 47878;
  const recFile = join(FW, "records.jsonl");
  const fakeHub = spawn("node", ["-e", `
    const http = require("http");
    const fs = require("fs");
    const rec = r => fs.appendFileSync(${JSON.stringify(recFile)}, JSON.stringify(r) + "\\n");
    http.createServer((req, res) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const u = new URL(req.url, "http://x");
        let parsedBody = null;
        try { parsedBody = JSON.parse(body); } catch {}
        rec({ method: req.method, path: u.pathname,
          body: parsedBody,
          headers: { pubkey: req.headers["x-trantor-pubkey"] || "", sig: req.headers["x-trantor-sig"] || "", ts: req.headers["x-trantor-ts"] || "", nonce: req.headers["x-trantor-nonce"] || "" } });
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        // /peer is the "do I exist already?" probe — the genesis identity is UNKNOWN (enforce).
        if (req.method === "GET" && u.pathname === "/peer") return send(401, { error: "unknown identity" });
        if (req.method === "POST" && u.pathname === "/invite") return send(200, { token: ${JSON.stringify(inviteToken)}, scopes: [{ project: "genesis-e", role: "write" }], expiresAt: Date.now() + 60000 });
        if (req.method === "POST" && u.pathname === "/enroll") return send(200, { ok: true, identity: { name: "genesis-e" }, scopes: [{ project: "genesis-e", role: "write" }] });
        if (req.method === "POST" && u.pathname === "/register") return send(200, { ok: true, session: "genesis:genesis-e" });
        if (req.method === "POST" && u.pathname === "/project") return send(200, { ok: true, project: "genesis-e", brief: "drill" });
        if (req.method === "POST" && u.pathname === "/task") return send(200, { ok: true, task: { id: 7001, project: "genesis-e", title: "genesis: genesis-e", status: "todo" } });
        send(404, { error: "not found" });
      });
    }).listen(${FPORT});
  `], { stdio: "ignore" });
  let fakeUp = false;
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${FPORT}/ping`, { signal: AbortSignal.timeout(300) }); fakeUp = true; break; } catch { await sleep(50); } }
  ok("fake enforce hub is up", fakeUp);

  const fhub = `http://127.0.0.1:${FPORT}`;
  const fenv = { ...process.env, HOME: FW, AGENT_BUS_DIR: bus, RELAY_URL: fhub,
    TRANTOR_DEV_ROOT: join(FW, "dev"), TRANTOR_NO_UPDATE_CHECK: "1" };
  mkdirSync(join(FW, "dev"), { recursive: true });
  const e = spawnSync("node", [join(ROOT, "bin", "new.mjs"), "genesis-e", "--json"], { encoding: "utf8", cwd: FW, env: fenv });
  let eJson = null; try { eJson = JSON.parse(e.stdout); } catch {}
  await sleep(150);   // let the fake hub's file writes drain before we read them back
  try { for (const l of readFileSync(recFile, "utf8").trim().split("\n").filter(Boolean)) recorded.push(JSON.parse(l)); } catch {}
  ok("#6049: genesis on an enforce hub succeeds via owner invite", eJson?.card === 7001, `status ${e.status} ${(e.stderr || e.stdout).slice(-200)}`);
  const invited = recorded.filter(r => r.method === "POST" && r.path === "/invite");
  ok("#6049: the owner INVITE was minted (enrollment, not tofu)", invited.length === 1);
  const enrolled = recorded.filter(r => r.method === "POST" && r.path === "/enroll");
  ok("#6049: the genesis identity ENROLLED with the invite", enrolled.length >= 1);
  ok("#6068: the genesis identity enrolls as a tool", enrolled[0]?.body?.kind === "tool", JSON.stringify(enrolled[0]));
  const registered = recorded.filter(r => r.method === "POST" && r.path === "/register");
  ok("#6068: the genesis peer registers as a tool", registered[0]?.body?.kind === "tool", JSON.stringify(registered[0]));
  for (const p of ["/project", "/task"]) {
    const rec = recorded.find(r => r.method === "POST" && r.path === p);
    ok(`#6049: ${p} was signed (pubkey+sig+ts+nonce headers)`, !!rec && !!rec.headers.pubkey && !!rec.headers.sig && !!rec.headers.ts && !!rec.headers.nonce, JSON.stringify(rec));
  }
  fakeHub.kill();
  try { rmSync(FW, { recursive: true, force: true }); } catch {}
}

// ── #6110: an owner-invite failure OTHER than "no-owner-key" is logged, not swallowed ───────────
// Before this fix, when enrollViaOwnerInvite() failed for any reason besides a missing owner key
// (e.g. the hub's /invite endpoint itself refused or errored), `trantor new` silently fell through
// to the plain /project POST with no enrollment and no explanation — the operator only ever saw
// the downstream "hub 401 on /project" with no hint that the OWNER-INVITE step was what broke.
// This drill makes an owner key present (so the "no-owner-key" branch is NOT taken) but has the
// fake hub's /invite endpoint fail, forcing enrollViaOwnerInvite() to return
// { ok:false, reason:"invite-500" } — and asserts that exact reason lands on stderr.
{
  const FW = mkdtempSync(join(tmpdir(), "trantor-new-invite-fail-"));
  const bus = join(FW, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  const keys = join(bus, "keys");
  mkdirSync(keys, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = (k) => Buffer.from(k.export({ format: "jwk" }).d || k.export({ format: "jwk" }).x, "base64url").toString("hex");
  writeFileSync(join(keys, "drill-owner2.json"), JSON.stringify({
    name: "drill-owner2", kind: "agent",
    pubkey: hex(publicKey), privkey: hex(privateKey), createdAt: Date.now(),
  }));
  writeFileSync(join(bus, "config.json"), JSON.stringify({ ownerIdentity: "drill-owner2" }));
  writeFileSync(join(bus, "autonomy.json"), JSON.stringify({ version: 1, defaults: { harness: "bypass" }, projects: {} }));

  const IPORT = 47880;
  const inviteFailHub = spawn("node", ["-e", `
    const http = require("http");
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        // /peer: unknown identity (enforce) → forces the owner-invite path.
        if (req.method === "GET" && req.url.startsWith("/peer")) return send(401, { error: "unknown identity" });
        // /invite: the owner-invite mint itself fails — NOT a no-owner-key case.
        if (req.method === "POST" && req.url === "/invite") return send(500, { error: "invite minting broke" });
        if (req.method === "POST" && req.url === "/project") return send(401, { error: "unknown identity" });
        send(200, { ok: true });
      });
    }).listen(${IPORT});
  `], { stdio: "ignore" });
  let inviteFailUp = false;
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${IPORT}/x`); inviteFailUp = true; break; } catch { await sleep(50); } }
  ok("invite-fail fake hub is up", inviteFailUp);
  const ij = spawnSync("node", [join(ROOT, "bin", "new.mjs"), "genesis-g", "--json"], {
    encoding: "utf8", cwd: FW,
    env: { ...process.env, HOME: FW, AGENT_BUS_DIR: bus, RELAY_URL: `http://127.0.0.1:${IPORT}`,
      TRANTOR_DEV_ROOT: join(FW, "dev"), TRANTOR_NO_UPDATE_CHECK: "1" },
  });
  ok("#6110: an owner-invite failure (not no-owner-key) is logged to stderr with its reason",
    (ij.stderr || "").includes("genesis: enrollment via owner invite failed: invite-500"), (ij.stderr || "").slice(-400));
  inviteFailHub.kill();
  try { rmSync(FW, { recursive: true, force: true }); } catch {}
}

// ── #6049: the refusal reason is surfaced, not swallowed ────────────────────────────────────────
// The drill's original failure printed only "hub 401 on /project" with card:null. A hub that
// refuses a signed write must name WHY (the enforce "unknown identity") so the operator can act.
{
  const FW = mkdtempSync(join(tmpdir(), "trantor-new-refuse-"));
  const bus = join(FW, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, "autonomy.json"), JSON.stringify({ version: 1, defaults: { harness: "bypass" }, projects: {} }));
  const RPORT = 47879;
  const refuseHub = spawn("node", ["-e", `
    const http = require("http");
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (req.method === "POST" && req.url === "/project") return send(401, { error: "unknown identity" });
        if (req.method === "POST" && req.url === "/task") return send(200, { ok: true, task: { id: 8001 } });
        send(200, { ok: true });
      });
    }).listen(${RPORT});
  `], { stdio: "ignore" });
  let refuseUp = false;
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${RPORT}/x`); refuseUp = true; break; } catch { await sleep(50); } }
  ok("refusal fake hub is up", refuseUp);
  const rj = spawnSync("node", [join(ROOT, "bin", "new.mjs"), "genesis-f", "--json"], {
    encoding: "utf8", cwd: FW,
    env: { ...process.env, HOME: FW, AGENT_BUS_DIR: bus, RELAY_URL: `http://127.0.0.1:${RPORT}`,
      TRANTOR_DEV_ROOT: join(FW, "dev"), TRANTOR_NO_UPDATE_CHECK: "1" },
  });
  const refuseOut = (rj.stdout || "") + (rj.stderr || "");
  ok("#6049: the 401 reason is carried in the CLI output (not a bare 'hub 401')", refuseOut.includes("unknown identity"), refuseOut.slice(-300));
  refuseHub.kill();
  try { rmSync(FW, { recursive: true, force: true }); } catch {}
}

hub.kill();
try { rmSync(W, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? "✅" : "❌"} new: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
