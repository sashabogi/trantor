#!/usr/bin/env node
// trantor — cross-project DISCOVERY and overseer-brokered INTRODUCTION.
//
// The gap this covers: sending across projects always worked (/send authorizes against the SENDER's
// project), but the roster was scoped, so two sessions the operator had declared codependent could
// not learn each other's session ids. The overseer told both to "coordinate over the bus" and
// neither could find the other, leaving the human to carry messages between two agents.
//
// Isolated: random port, tmp dirs, enforce auth, real Ed25519 signatures.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/[^/]+$/, "");
const { generate, signRequest } = await import("./lib/identity.mjs");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), `td-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, [join(HERE, "hub.mjs")], {
  env: {
    ...process.env, HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
    RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu",
    RELAY_OVERSEER_TICK_MS: "300", RELAY_ONLINE_MS: "60000", RELAY_URL: undefined,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let er = ""; hub.stderr.on("data", d => { er += d; });

async function sFetch(id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  let hdrs = {};
  if (id) { try { hdrs = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body }); } catch {} }
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { _raw: txt.slice(0, 400) }; }
  return { status: r.status, json: j };
}
const sessionsIn = (res) => (res.json.peers || []).map(p => p.session);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + "/health")).ok; } catch {} if (!up) await sleep(80); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));
  console.log("\n# test-discovery — linked projects can find each other");

  // Owner, plus two agents each scoped to ONE project — the normal per-project enrollment.
  const owner = generate();
  await sFetch(owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  const mkAgent = async (name, project) => {
    const id = generate();
    const inv = await sFetch(owner, "POST", "/invite", { name, scopes: [{ project, role: "write" }], ttlSec: 3600 });
    await sFetch(id, "POST", "/enroll", { token: inv.json.token, pubkey: id.pubkey, name, kind: "agent" });
    await sFetch(id, "POST", "/register", { session: name, project, status: `active in ${project}` });
    return id;
  };
  const health = await mkAgent("agent:projHealth", "projHealth");
  const scribe = await mkAgent("agent:projScribe", "projScribe");
  await mkAgent("agent:projOther", "projOther");

  // 1. Before any link is declared, scoping holds — this is the behaviour we are NOT breaking.
  let seen = sessionsIn(await sFetch(health, "GET", "/peers"));
  ok("unlinked: a session does not see another project's sessions", !seen.includes("agent:projScribe"), seen.join(", "));
  ok("unlinked: it still sees its own", seen.includes("agent:projHealth"), seen.join(", "));

  // 2. Declare the link the operator would declare. Discovery opens BOTH ways.
  await sFetch(owner, "POST", "/policy", { link: { projects: ["projHealth", "projScribe"], reason: "shared schema" } });
  seen = sessionsIn(await sFetch(health, "GET", "/peers"));
  ok("linked: health can now discover the scribe session", seen.includes("agent:projScribe"), seen.join(", "));
  const seenBack = sessionsIn(await sFetch(scribe, "GET", "/peers"));
  ok("linked: discovery is mutual", seenBack.includes("agent:projHealth"), seenBack.join(", "));

  // 3. A link is not a skeleton key — an unrelated project stays invisible.
  ok("an unlinked third project stays hidden", !seen.includes("agent:projOther"), seen.join(", "));

  // 4. Discovery is the ONLY thing that was missing: the DM itself was always allowed.
  const dm = await sFetch(health, "POST", "/send", { from: "agent:projHealth", to: "agent:projScribe", text: "splitting the schema work with you" });
  ok("a cross-project DM is accepted", dm.status < 400, `status ${dm.status}`);

  // 5. The overseer INTRODUCES colliding parties to each other, not only the duty seat.
  //    Two live sessions in one project is the simplest condition that fires.
  const a = await mkAgent("agent:projPair-a", "projPair");
  const b = await mkAgent("agent:projPair-b", "projPair");
  await sFetch(owner, "POST", "/policy", { autonomy: { projPair: 2 } });
  await sFetch(a, "POST", "/register", { session: "agent:projPair-a", project: "projPair", status: "working" });
  await sFetch(b, "POST", "/register", { session: "agent:projPair-b", project: "projPair", status: "working" });
  await sleep(1600);
  const inboxOf = async (id, s) => (await sFetch(id, "GET", `/inbox?session=${encodeURIComponent(s)}&since=0&peek=1`)).json.messages || [];
  const toA = (await inboxOf(a, "agent:projPair-a")).filter(m => m.from === "hub:duty" && /🤝/.test(m.text));
  const toB = (await inboxOf(b, "agent:projPair-b")).filter(m => m.from === "hub:duty" && /🤝/.test(m.text));
  ok("each colliding party is introduced", toA.length >= 1 && toB.length >= 1, `a=${toA.length} b=${toB.length}`);
  ok("the introduction names the OTHER party's session id", toA.length > 0 && /agent:projPair-b/.test(toA[0].text) && !/you and agent:projPair-a/.test(toA[0].text), toA[0]?.text?.slice(0, 120));
  ok("it tells them to coordinate directly rather than via a human", toA.length > 0 && /relay_send/.test(toA[0].text) && /No human/i.test(toA[0].text));

  // 6. A standing condition must not re-introduce every tick — that would wake both seats forever.
  await sleep(1500);
  const again = (await inboxOf(a, "agent:projPair-a")).filter(m => m.from === "hub:duty" && /🤝/.test(m.text));
  ok("a standing collision introduces ONCE per episode", toA.length >= 1 && again.length === toA.length, `${toA.length} -> ${again.length}`);
} finally {
  try { hub.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
