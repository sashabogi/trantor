#!/usr/bin/env node
// #12112 regression. /stream pushed every project's bus messages and events to any signed reader:
// pushToStreams and pushEventToStreams filtered by session only, never by the signer's scopes. A
// key scoped to projA could open /stream?events=1 and watch projB live, the one leak the iOS
// companion's narrow keys must not inherit. The property: a stream carries exactly what /inbox and
// /events would let its signer read. An owner stream on the same hub sees both projects, so the
// scoped reader's silence on projB is a filter, not an empty hub.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

async function sFetch(base, id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body });
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
// Open a signed SSE stream and keep everything it says in `buf`.
async function openStream(base, id, session, { events = true } = {}) {
  const path = `/stream?session=${encodeURIComponent(session)}${events ? "&events=1" : ""}`;
  const ac = new AbortController();
  const r = await fetch(base + path, { headers: signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method: "GET", path }), signal: ac.signal });
  const s = { status: r.status, buf: "", close: () => ac.abort() };
  if (r.ok) (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of r.body) s.buf += dec.decode(chunk, { stream: true }); } catch {}
  })();
  return s;
}

console.log("# /stream is scope-filtered (#12112)");

const dir = mkdtempSync(join(tmpdir(), "trantor-12112-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const hub = await startTestHub({ dir, env: {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000",
} });
try {
  const base = hub.base;
  const owner = generate(); const reader = generate();
  const own = await sFetch(base, owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("owner enrolled", own.status < 400, `status ${own.status}`);
  const inv = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "read" }], ttlSec: 60, kind: "human" });
  const reg = await sFetch(base, reader, "POST", "/enroll", { token: inv.json.token || "", name: "readerA", kind: "human" });
  ok("projA-only reader enrolled by invite", reg.status < 400 && (reg.json.scopes || []).every(s => s.project === "projA"), `status ${reg.status} ${JSON.stringify(reg.json.scopes)}`);

  const unsigned = await fetch(`${base}/stream?session=x&events=1`).then(r => { r.body?.cancel(); return r.status; });
  ok("fixture enforces: unsigned /stream -> 401", unsigned === 401, `got ${unsigned}`);

  const ownerStream = await openStream(base, owner, "owner");
  const readerStream = await openStream(base, reader, "readerA");
  // The scoped key asks for someone else's mailbox: direct messages to it must stay private. Message
  // channel only: the FEED's "message" events are project-scoped by design, as /events is.
  const spoofStream = await openStream(base, reader, "victim", { events: false });
  ok("all three streams open", [ownerStream, readerStream, spoofStream].every(s => s.status === 200));
  await sleep(150);

  await sFetch(base, owner, "POST", "/send", { from: "owner", to: "all", project: "projA", text: "MSG-ALPHA for projA" });
  await sFetch(base, owner, "POST", "/send", { from: "owner", to: "all", project: "projB", text: "MSG-BRAVO for projB" });
  await sFetch(base, owner, "POST", "/send", { from: "owner", to: "victim", project: "projA", text: "MSG-DIRECT for victim" });
  await sFetch(base, owner, "POST", "/task", { project: "projA", title: "CARD-ALPHA", status: "todo", by: "owner" });
  await sFetch(base, owner, "POST", "/task", { project: "projB", title: "CARD-BRAVO", status: "todo", by: "owner" });
  await sleep(400);

  ok("owner stream sees projA and projB messages", ownerStream.buf.includes("MSG-ALPHA") && ownerStream.buf.includes("MSG-BRAVO"));
  ok("owner stream sees projA and projB events", ownerStream.buf.includes("CARD-ALPHA") && ownerStream.buf.includes("CARD-BRAVO"));
  ok("reader stream sees its projA message", readerStream.buf.includes("MSG-ALPHA"));
  ok("reader stream sees its projA event", readerStream.buf.includes("CARD-ALPHA"));
  ok("reader stream never sees the projB message", !readerStream.buf.includes("MSG-BRAVO"));
  ok("reader stream never sees the projB event", !readerStream.buf.includes("CARD-BRAVO"));
  ok("a stream opened as another session gets none of its direct messages", !spoofStream.buf.includes("MSG-DIRECT"));

  for (const s of [ownerStream, readerStream, spoofStream]) s.close();
} finally {
  await hub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
