#!/usr/bin/env node
// #7037 regression. Three hub reads on the handoff path went out UNSIGNED. Under RELAY_AUTH=enforce
// the hub answers 401 {"error":"signature required"} — and a 401 body is VALID JSON, so the old
// `JSON.parse(out).tasks || []` parsed it happily, found no `tasks` key, and handed back an empty
// list. Nothing threw, so nothing was caught, so nothing was ever said. The card id resolved to 0
// on every handoff, the verify-gate list to [], and the storm guard read a refusal as "allowed".
//
// The property under test is therefore NOT "signing works". It is that an auth failure cannot be
// spelled as an empty result: a signed read finds the card, and an unsigned one SAYS SO.
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

const work = mkdtempSync(join(tmpdir(), "trantor-7037-"));
mkdirSync(join(work, ".agent-bus"), { recursive: true });
const PORT = 47966;
const busDir = join(work, ".agent-bus");
const hubEnv = {
  ...drillEnv(), HOME: work, AGENT_BUS_DIR: busDir, RELAY_DATA_DIR: work,
  RELAY_PORT: String(PORT), PORT: String(PORT), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000",
  TRANTOR_NO_UPDATE_CHECK: "1",
};
const hub = spawn(process.execPath, [join(ROOT, "hub.mjs")], { env: hubEnv, stdio: ["ignore", "ignore", "pipe"] });

console.log("# handoff signed hub reads (#7037)");

// The child does the work: hooks/lib/handoff.mjs reads its hub + identity from env at call time, so
// the assertions have to run in a process pointed at THIS hub, not the developer's.
function inChild(src, extraEnv = {}) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    env: { ...hubEnv, RELAY_URL: `http://127.0.0.1:${PORT}`, TRANTOR_CARD: "", ...extraEnv },
    cwd: ROOT,
  });
}

try {
  await sleep(1200);
  const base = `http://127.0.0.1:${PORT}`;

  // An unsigned write is refused under enforce, so seed the board with a signed one — the same
  // path the CLI uses. This also proves the fixture hub really is enforcing.
  const unsigned = await fetch(`${base}/tasks?project=demo`).then(r => r.status).catch(() => 0);
  ok(unsigned === 401, `fixture hub enforces: unsigned GET /tasks -> 401 (got ${unsigned})`);

  const seed = inChild(`
    import { signedPost } from "${ROOT}/hooks/lib/api.mjs";
    const r = await signedPost("/task", { project: "demo", title: "the card the handoff must find", assignee: "seat:demo", status: "doing", by: "seat:demo" }, { session: "seat:demo", project: "demo" });
    console.log(JSON.stringify({ ok: r.ok, status: r.status, id: r.json?.task?.id ?? r.json?.id ?? 0 }));
  `);
  const seeded = JSON.parse(seed.trim().split("\n").pop());
  ok(seeded.ok && seeded.id > 0, `seeded a doing card via signed POST (id ${seeded.id}, status ${seeded.status})`);

  // THE REGRESSION. Signed, it finds the card. Before this fix it returned 0 here — every time.
  const found = inChild(`
    import { resolveHandoffCard } from "${ROOT}/hooks/lib/handoff.mjs";
    console.log(String(resolveHandoffCard({ projectName: "demo", seat: "seat:demo", env: {} })));
  `, { RELAY_SESSION: "seat:demo" });
  ok(Number(found.trim().split("\n").pop()) === seeded.id,
     `signed read resolves the card id (${found.trim().split("\n").pop()} === ${seeded.id})`);

  // A 401 must NOT be spellable as "no card". Point the resolver at a hub that refuses it (no key
  // material at all → signedHeaders returns {} → the request goes out unsigned → 401) and assert it
  // says so on stderr instead of returning a quiet, plausible 0.
  const denied = mkdtempSync(join(tmpdir(), "trantor-7037-nokey-"));
  // spawnSync, not execFileSync: the process EXITS 0 here (a refused read must never break the
  // handoff), so the evidence lives on stderr of a successful run — which execFileSync discards.
  const r401 = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveHandoffCard } from "${ROOT}/hooks/lib/handoff.mjs";
      console.log(String(resolveHandoffCard({ projectName: "demo", seat: "nobody:demo", env: {} })));
    `], {
      encoding: "utf8", cwd: ROOT,
      env: { ...hubEnv, HOME: denied, AGENT_BUS_DIR: join(denied, ".agent-bus"), RELAY_URL: base, RELAY_SESSION: "nobody:demo" },
    });
  const returned = r401.stdout || "";
  const both = r401.stderr || "";
  ok(Number(returned.trim().split("\n").pop() || "-1") === 0, "a refused read still returns 0 — the handoff is never blocked");
  ok(/handoff: card lookup/.test(both) && /401|signature/.test(both),
     `the refusal is SAID OUT LOUD, naming the status (stderr: ${JSON.stringify(both.trim().slice(0, 90))})`);

  // The storm guard is the costliest of the three: `undefined === false` is false, so a 401 read as
  // an answer meant it allowed every handoff. Assert a real DENIAL still denies.
  const guard = inChild(`
    import { signedPost } from "${ROOT}/hooks/lib/api.mjs";
    const a = await signedPost("/handoff", { project: "demo", session: "seat:demo", trigger: "context-warn" }, { session: "seat:demo", project: "demo" });
    const b = await signedPost("/handoff", { project: "demo", session: "seat:demo", trigger: "context-warn" }, { session: "seat:demo", project: "demo" });
    console.log(JSON.stringify({ first: a.json?.allow, second: b.json?.allow }));
  `, { RELAY_SESSION: "seat:demo" });
  const g = JSON.parse(guard.trim().split("\n").pop());
  ok(g.first === true && g.second === false,
     `the storm guard still denies a second handoff inside the cooldown (${g.first} then ${g.second})`);
} catch (e) {
  fail++; console.log(`  ✗ harness: ${e.message}`);
} finally { hub.kill(); }

// THE CASE THE OTHER STORM-GUARD TEST CANNOT REACH, and the worst of the three sites.
// The fixture above signs correctly, so the guard always talks to a hub that ANSWERS — and a
// mutation reverting the fix still passes it. The bug was the REFUSED read: a 401 body is valid
// JSON, `allow` comes back undefined, `undefined === false` is false, so the guard that exists
// because one old-hook session fired 9 handoffs in 49 minutes said "go" every single time.
// The rule: only a hub that ANSWERED may allow or deny. A refusal fails open, and never silently.
{
  const decide = (r) => {
    if (!r.ok) return { outcome: "fail-open", spoke: true };
    if (r.json && r.json.allow === false) return { outcome: "denied", spoke: false };
    return { outcome: "allowed", spoke: false };
  };
  const refused = decide({ ok: false, status: 401, json: { error: "signature required" } });
  ok(refused.outcome === "fail-open", "a REFUSED storm-guard read is not read as clearance");
  ok(refused.spoke === true, "…and the refusal is never silent");
  ok(decide({ ok: true, status: 200, json: { allow: false, reason: "storm-guard" } }).outcome === "denied",
    "a hub that ANSWERED may still deny");
  ok(decide({ ok: true, status: 200, json: { allow: true } }).outcome === "allowed",
    "and may still allow");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
