#!/usr/bin/env node
// trantor unified event-log tests (2026-07-28).
//
// v0.17.54 reframed the board as ONE append-only log with two lenses: the BOARD (derived index,
// unchanged) and the FEED (the log itself). `state.cardEvents` became `state.events` and now carries
// bus messages, presence edges, focus shifts, handoffs, lessons and verify gates alongside card
// lifecycle. The whole design rests on two promises, and these tests exist to keep them honest:
//
//   1. NOTHING REGRESSES. /history is the TIMELINE's feed and predates the log, so it must keep
//      returning card events and ONLY card events — the new dotted types must never leak into it.
//      Card events must also keep their legacy flat shape and legacy type names.
//   2. THE THREAD IS DERIVED, NOT STORED. Asking /events for a card id returns that card's own
//      events PLUS every message citing "#id" — the join that makes the FEED chat-shaped.
//
// Plus: the on-disk migration (an old `cardEvents` file must load as `events`), the legacy mirror
// written back for downgrade safety, filter composition, and SSE channel separation.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnHub(port, { seed = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-events-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  if (seed) writeFileSync(join(dir, "bus.json"), JSON.stringify(seed));
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor unified event-log tests");

// ── Hub A: the log itself — every type lands, /history stays card-only, threads derive ───────────
const PA = 47901, hubA = spawnHub(PA);
let errA = ""; hubA.stderr.on("data", d => errA += d);
await sleep(800);
try {
  const A = mk(`http://127.0.0.1:${PA}`); const PROJ = "evtA";

  await A.post("/register", { session: "host:evtA", project: PROJ, status: "orchestrating" });
  await A.post("/focus", { session: "host:evtA", project: PROJ, title: "wire the unified log" });
  const card = await A.post("/task", { project: PROJ, title: "build /events", by: "host:evtA", assignee: "codex:evtA", status: "doing" });
  const cid = card?.task?.id;
  await A.post("/send", { from: "codex:evtA", to: "all", project: PROJ, text: `taking #${cid} — ETA 20m` });
  await A.post("/task/update", { id: cid, status: "done", by: "codex:evtA" });
  await A.post("/lesson", { text: "keep legacy card type names", scope: PROJ, by: "codex:evtA" });
  const gate = await A.post("/verify-gate", { project: PROJ, claim: "history is card-only", by: "codex:evtA" });
  await A.post("/verify-gate", { project: PROJ, id: gate?.gate?.id, resolve: true, status: "verified", by: "host:evtA" });
  await A.post("/handoff", { project: PROJ, session: "host:evtA", trigger: "context-warn", id: "evtA-1" });

  const all = (await A.get(`/events?project=${PROJ}`)).events;
  const types = new Set(all.map(e => e.type));
  ok("card lifecycle logged", types.has("created") && types.has("moved"));
  ok("bus message logged", types.has("message"));
  ok("presence edge logged", types.has("presence.online"));
  ok("focus logged", types.has("focus"));
  ok("lesson logged", types.has("lesson"));
  ok("verify gate open+resolve logged", types.has("verify.gate.opened") && types.has("verify.gate.resolved"));
  ok("handoff logged", types.has("handoff.written"));
  ok("event ids are monotonic", all.every((e, i) => i === 0 || e.id > all[i - 1].id));
  ok("every event carries ts/type/project/by", all.every(e => e.ts && e.type && "project" in e && "by" in e));

  // PROMISE 1 — /history must be card events only, in the legacy shape.
  const hist = (await A.get(`/history?project=${PROJ}`)).events;
  const htypes = [...new Set(hist.map(e => e.type))];
  ok("/history returns ONLY card types", htypes.every(t => ["created", "moved", "updated"].includes(t)), `(got ${JSON.stringify(htypes)})`);
  ok("/history excludes messages", !hist.some(e => e.type === "message"));
  ok("/history excludes presence", !hist.some(e => String(e.type).startsWith("presence.")));
  const cev = hist.find(e => e.type === "moved");
  ok("card event keeps legacy flat shape", !!cev && "taskId" in cev && "title" in cev && "from" in cev && "to" in cev && "assignee" in cev);

  // PROMISE 2 — the thread is a JOIN, not a stored structure.
  const thread = (await A.get(`/events?project=${PROJ}&taskId=${cid}`)).events;
  ok("thread includes the card's own events", thread.some(e => e.taskId === cid && e.type === "created"));
  ok("thread includes messages CITING the card", thread.some(e => e.type === "message" && (e.refs || []).includes(cid)));
  ok("thread excludes unrelated events", !thread.some(e => e.type === "handoff.written"));
  ok("message events carry refs[] not taskId", all.filter(e => e.type === "message").every(e => Array.isArray(e.refs) && e.taskId === undefined));

  // /card must keep counting CARD events only, even though messages now live in the same array.
  const detail = await A.get(`/card?id=${cid}`);
  ok("/card events stay card-only", (detail.events || []).every(e => ["created", "moved", "updated"].includes(e.type)));
  ok("/card still joins the citing message separately", (detail.messages || []).some(m => m.text.includes(`#${cid}`)));

  // filters compose
  const pres = (await A.get(`/events?project=${PROJ}&type=presence.`)).events;
  ok("type= prefix match works", pres.length > 0 && pres.every(e => e.type.startsWith("presence.")));
  const byCodex = (await A.get(`/events?project=${PROJ}&by=codex:evtA`)).events;
  ok("by= actor filter works", byCodex.length > 0 && byCodex.every(e => e.by === "codex:evtA"));
  const multi = (await A.get(`/events?project=${PROJ}&type=message,lesson`)).events;
  ok("type= comma list works", multi.length > 0 && multi.every(e => ["message", "lesson"].includes(e.type)));
  const since = (await A.get(`/events?project=${PROJ}&since=${all[all.length - 2].id}`)).events;
  ok("since= returns only newer events", since.every(e => e.id > all[all.length - 2].id));
  const other = (await A.get(`/events?project=nosuchproject`)).events;
  ok("project filter isolates", other.length === 0);

  // presence.online fires ONCE per transition, not per heartbeat
  for (let i = 0; i < 4; i++) await A.post("/register", { session: "host:evtA", project: PROJ });
  const onEvents = (await A.get(`/events?project=${PROJ}&type=presence.online&by=host:evtA`)).events;
  ok("presence.online is edge-triggered, not per-heartbeat", onEvents.length === 1, `(got ${onEvents.length})`);

  // SSE: the log rides a NAMED channel so legacy message consumers can't see it
  const res = await fetch(`http://127.0.0.1:${PA}/stream?session=probe&events=1`);
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = "";
  const reading = (async () => { for (let i = 0; i < 60; i++) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); if (/event: ev\ndata: [^\n]*sse probe/.test(buf)) break; } })();
  await sleep(200);
  await A.post("/send", { from: "kimi:evtA", to: "all", project: PROJ, text: "sse probe" });
  await Promise.race([reading, sleep(2000)]);
  try { rd.cancel(); } catch {}
  ok("events push on the named 'ev' SSE channel", buf.includes("event: ev"));
  ok("/stream itself logs the probe session's presence edge", buf.includes("presence.online"));
  const frames = buf.split("\n\n").filter(Boolean);
  ok("bus messages still push on the DEFAULT channel", frames.some(f => !f.startsWith("event:") && f.includes("sse probe")));
  ok("the same event also rides the named channel", frames.some(f => f.startsWith("event: ev") && f.includes("sse probe")));

  // deleting a project forgets its log too
  await A.post("/project/delete", { project: PROJ });
  ok("project delete purges its events", (await A.get(`/events?project=${PROJ}`)).events.length === 0);
} finally { hubA.kill(); }
ok("hub A clean stderr", !/TypeError|ReferenceError|not defined/.test(errA), errA.slice(0, 300));

// ── Hub B: on-disk migration — an OLD state file (cardEvents, no events) must load ───────────────
const PB = 47902;
const legacy = {
  messages: [], peers: {}, seq: 0, taskSeq: 2, projectMeta: {}, lessons: [],
  tasks: [{ id: 1, project: "evtB", title: "legacy card", status: "done", by: "host:evtB", ts: 1, updated: 2, history: [] }],
  cardEvents: [
    { id: 1, ts: 1, type: "created", taskId: 1, project: "evtB", title: "legacy card", from: null, to: "todo", by: "host:evtB" },
    { id: 2, ts: 2, type: "moved", taskId: 1, project: "evtB", title: "legacy card", from: "todo", to: "done", by: "host:evtB" },
  ],
  cardEventsBackfilled: true,
};
const hubB = spawnHub(PB, { seed: legacy });
let errB = ""; hubB.stderr.on("data", d => errB += d);
await sleep(800);
try {
  const B = mk(`http://127.0.0.1:${PB}`);
  const ev = (await B.get(`/events?project=evtB`)).events;
  ok("legacy cardEvents load as events", ev.length === 2 && ev[0].type === "created", `(got ${ev.length})`);
  ok("legacy history still served", (await B.get(`/history?project=evtB`)).events.length === 2);

  // new events append onto the migrated log without colliding on id
  await B.post("/send", { from: "host:evtB", to: "all", project: "evtB", text: "after migration" });
  const ev2 = (await B.get(`/events?project=evtB`)).events;
  // /send touches the sender, so a first-seen sender adds presence.online BEFORE its message.
  const msgEv = ev2.find(e => e.type === "message");
  ok("new events continue the migrated id sequence", !!msgEv && msgEv.id > 2 && ev2.every((e, i) => i === 0 || e.id > ev2[i - 1].id), `(got ids ${ev2.map(e => e.id)})`);
  ok("the migrated card events keep ids 1 and 2", ev2[0].id === 1 && ev2[1].id === 2);

  // downgrade safety: the persisted file mirrors a card-only `cardEvents` key for an older hub
  await sleep(1400);
  const onDisk = JSON.parse(readFileSync(join(hubB._dir, "bus.json"), "utf8"));
  ok("persists the unified log under `events`", Array.isArray(onDisk.events) && onDisk.events.length === ev2.length && onDisk.events.some(e => e.type === "message"));
  ok("mirrors a card-only `cardEvents` for downgrade", Array.isArray(onDisk.cardEvents)
    && onDisk.cardEvents.length === 2
    && onDisk.cardEvents.every(e => ["created", "moved", "updated"].includes(e.type)),
    `(got ${JSON.stringify((onDisk.cardEvents || []).map(e => e.type))})`);
} finally { hubB.kill(); }
ok("hub B clean stderr", !/TypeError|ReferenceError|not defined/.test(errB), errB.slice(0, 300));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
