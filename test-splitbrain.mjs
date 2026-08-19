#!/usr/bin/env node
// trantor hub split-brain detection drill.
//
// The fault: a project's crew registers on hub A while its board and orchestrator read hub B.
// Nothing errors — every seat is green, half the work simply records where nobody looks. It cost
// two full diagnosis sessions in crebral-health before anyone thought to compare the two hubs.
// These drills pin the cross-check AND the trap that made the original diagnosis so slow: an
// unsigned read of an enforce hub answers "signature required", and treating that as an empty
// roster reports a hub full of agents as deserted.
import http from "node:http";
import { normalizeHub, isLocalHub, hubsFromConfig, probeHub, analyze, scan } from "./lib/splitbrain.mjs";
import { loadOrCreate } from "./lib/identity.mjs";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

console.log("# trantor hub split-brain drill");

// ---- URL identity ---------------------------------------------------------------------
ok("a trailing slash is not a different hub", normalizeHub("http://h:4477/") === normalizeHub("http://h:4477"));
ok("localhost and 127.0.0.1 are the same hub", normalizeHub("http://localhost:4477") === "http://127.0.0.1:4477");
ok("loopback is recognised as local", isLocalHub("http://127.0.0.1:4477") && isLocalHub("http://localhost:4477"));
ok("a tailnet address is not local", !isLocalHub("http://100.79.242.104:4477"));

// ---- which hubs to check --------------------------------------------------------------
{
  const hubs = hubsFromConfig({ url: "http://127.0.0.1:4477", hubs: { a: "http://remote:4477", b: "http://remote:4477/", c: "http://other:4477" } });
  ok("every distinct hub is checked once, pins deduped", hubs.length === 3, `got ${hubs.map(h => h.url).join(", ")}`);
  ok("a hub remembers which pins pointed at it", hubs.find(h => h.url === "http://remote:4477")?.sources.length === 2);
}

// ---- THE TRAP: an enforce hub's refusal must never read as "nobody home" ---------------
const enforce = http.createServer((req, res) => {
  const signed = !!req.headers["x-trantor-sig"];
  res.writeHead(signed ? 200 : 401, { "content-type": "application/json" });
  res.end(signed
    ? JSON.stringify({ hubVersion: "0.17.69", authMode: "enforce", peers: [{ session: "codex:proj", project: "proj", online: true, lastSeen: Date.now() }] })
    : JSON.stringify({ error: "signature required" }));
});
await new Promise(r => enforce.listen(0, "127.0.0.1", r));
const ENFORCE = `http://127.0.0.1:${enforce.address().port}`;
{
  const blind = await probeHub(ENFORCE, null);
  ok("an UNSIGNED read of an enforce hub is not ok", !blind.ok);
  ok("...and reports WHY, instead of an empty roster", /not authorized/.test(blind.reason) && blind.peers.length === 0, blind.reason);
  const HOME = mkdtempSync(join(tmpdir(), "tt-sb-")); mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const prev = process.env.HOME; process.env.HOME = HOME;
  const id = loadOrCreate("drill@test", "human");
  process.env.HOME = prev;
  const seen = await probeHub(ENFORCE, id);
  ok("a SIGNED read of the same hub sees its live agent", seen.ok && seen.peers.length === 1, seen.reason);
  ok("the hub's auth mode and version come back with it", seen.authMode === "enforce" && seen.hubVersion === "0.17.69");
}
{
  const dead = await probeHub("http://127.0.0.1:1/", null, { timeoutMs: 800 });
  ok("an unreachable hub is unreachable, not empty", !dead.ok && /unreachable/.test(dead.reason));
}
enforce.close();

// ---- the cross-check ------------------------------------------------------------------
const LOCAL = "http://127.0.0.1:4477", REMOTE = "http://100.79.242.104:4477";
const probe = (url, peers) => ({ url, ok: true, reason: "", authMode: "", hubVersion: "", peers });
const live = (session, project) => ({ session, project, online: true, lastSeen: Date.now(), llm: "" });
const stale = (session, project) => ({ session, project, online: false, lastSeen: 0, llm: "" });

{ // the crebral-health case, exactly: crew local, project pinned remote
  const { findings } = analyze(
    [probe(LOCAL, [live("codex:crebral-health", "crebral-health"), live("kimi:crebral-health", "crebral-health")]),
     probe(REMOTE, [live("MacBook-Pro-M1:crebral-health", "crebral-health")])],
    { url: LOCAL, hubs: { "crebral-health": REMOTE } });
  ok("a project live on two hubs at once is CRITICAL", findings.length === 1 && findings[0].kind === "split" && findings[0].severity === "critical");
  ok("...and names both hubs and the sessions on each",
    findings[0].hubs.length === 2 && findings[0].message.includes("codex:crebral-health") && findings[0].message.includes("MacBook-Pro-M1:crebral-health"));
  ok("...and the fix points at the PIN, not at whichever hub is louder", findings[0].fix.includes(REMOTE));
}
{ // the whole crew on the wrong hub — no local half to compare against
  const { findings } = analyze(
    [probe(LOCAL, [live("codex:crm", "crm")]), probe(REMOTE, [])],
    { url: LOCAL, hubs: { crm: REMOTE } });
  ok("a crew entirely on the un-pinned hub is still caught", findings.length === 1 && findings[0].kind === "off-pin");
  ok("...and says the work records where nobody reads", /nobody is reading/.test(findings[0].message));
}
{ // live remote with no pin — the next session falls back to local and splits it
  const { findings } = analyze([probe(LOCAL, []), probe(REMOTE, [live("claude:fleet", "fleet")])], { url: LOCAL, hubs: {} });
  ok("a remote project with no pin is flagged before it splits", findings.length === 1 && findings[0].kind === "unpinned-remote" && findings[0].severity === "warn");
  ok("...with the exact pin command as the fix", findings[0].fix === `trantor hub set fleet ${REMOTE}`);
}
{ // healthy
  const { findings, blind, checked } = analyze(
    [probe(LOCAL, [stale("old:proj", "proj")]), probe(REMOTE, [live("MacBook-Pro-M1:proj", "proj")])],
    { url: LOCAL, hubs: { proj: REMOTE } });
  ok("one hub per project is clean", findings.length === 0 && blind.length === 0 && checked === 2);
  ok("a DEAD peer on the other hub is not a split", findings.length === 0);
}
{ // a pin nobody can read is its own fault
  const { findings, blind } = analyze(
    [probe(LOCAL, []), { url: REMOTE, ok: false, reason: "unreachable (timeout)", peers: [] }],
    { url: LOCAL, hubs: { proj: REMOTE } });
  ok("a pin aimed at an unreadable hub is reported", findings.some(f => f.kind === "pin-unreachable" && f.project === "proj"));
  ok("...and the unreadable hub is carried out as a BLIND SPOT, so a partial scan is never printed as clean",
    blind.length === 1 && blind[0].url === REMOTE);
}
{ // a project with no pin living on the local hub is the normal, quiet case
  const { findings } = analyze([probe(LOCAL, [live("MacBook-Pro-M1:newproj", "newproj")])], { url: LOCAL, hubs: {} });
  ok("a brand-new local-only project is not nagged about", findings.length === 0);
}

// ---- scan() end to end against a real pair of hubs -------------------------------------
{
  const mk = (peers) => { const s = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ authMode: "warn", hubVersion: "0.17.69", peers })); }); return s; };
  const a = mk([{ session: "codex:proj", project: "proj", online: true, lastSeen: Date.now() }]);
  const b = mk([{ session: "host:proj", project: "proj", online: true, lastSeen: Date.now() }]);
  await new Promise(r => a.listen(0, "127.0.0.1", r)); await new Promise(r => b.listen(0, "127.0.0.1", r));
  const A = `http://127.0.0.1:${a.address().port}`, B = `http://127.0.0.1:${b.address().port}`;
  const r = await scan({ url: A, hubs: { proj: B } }, null, { defaultUrl: A });
  ok("scan() probes both hubs and finds the split", r.findings.length === 1 && r.findings[0].kind === "split", JSON.stringify(r.findings.map(f => f.kind)));
  ok("scan() reports how many hubs actually answered", r.checked === 2);
  a.close(); b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
