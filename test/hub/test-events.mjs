#!/usr/bin/env node
// trantor unified event-log tests. The unified log rests on two promises, and these tests keep
// them honest: (1) /history is the TIMELINE's feed and stays card-events-only in the legacy
// shape; (2) the thread is DERIVED, not stored — /events for a card id joins the card's events
// with every message citing it. Plus the on-disk migration, filter composition, SSE separation.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
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

  // #7968: a seat's testing move posts `blast`; the hub keeps it on the card EVENT and nowhere else,
  // and /history keeps its legacy flat shape beside it.
  const c2 = (await A.post("/task", { project: PROJ, title: "blast card", by: "host:evtA", assignee: "codex:evtA", status: "doing" }))?.task?.id;
  const movedTo = async (to) => (await A.get(`/history?project=${PROJ}`)).events.filter(e => e.taskId === c2 && e.type === "moved" && e.to === to).pop();
  await A.post("/task/update", { id: c2, status: "testing", by: "codex:evtA", note: "verified at abc1234\nblast: 2 files depend on the 1 changed",
    blast: { base: "abc1234", changed: ["lib/a.mjs"], unindexed: [], dependents: 2, junk: "dropped" } });
  const bev = await movedTo("testing");
  ok("#7968: the moved card event carries blast", bev?.blast?.dependents === 2 && bev.blast.base === "abc1234" && bev.blast.changed[0] === "lib/a.mjs" && !("junk" in bev.blast), JSON.stringify(bev?.blast));
  ok("#7968: /history keeps the legacy flat shape beside blast", !!bev && "taskId" in bev && "title" in bev && "from" in bev && "to" in bev && "assignee" in bev);
  ok("#7968: blast never lands on the card itself", !("blast" in ((await A.get(`/tasks?project=${PROJ}`)).tasks.find(t => t.id === c2) || {})));
  await A.post("/task/update", { id: c2, status: "failed", by: "codex:evtA", blast: "7 files" });
  ok("#7968: a malformed blast is dropped, the move still lands", (await movedTo("failed")) && !("blast" in (await movedTo("failed"))));
  await A.post("/task/update", { id: c2, status: "done", by: "codex:evtA", blast: { unavailable: true, dependents: 99 } });
  ok("#7968: an unavailable blast is kept as exactly {unavailable:true}", JSON.stringify((await movedTo("done"))?.blast) === '{"unavailable":true}');
  ok("#7968: an update without blast carries none", !("blast" in ((await A.get(`/history?project=${PROJ}`)).events.find(e => e.taskId === c2 && e.type === "created") || {})));

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

// ── Hub C: /read — the human-opened-file signal (#7972, CodeGraph blueprint card 6) ──────────────
// The claim-shaped throttle: two posts inside the window append ONE file.read event, a third
// after the window appends another. Read through /events?type=file.read (exact); /history,
// the card-only feed, must never carry it. The window is shrunk via RELAY_CLAIM_TTL_MS.
const PC = 47903;
const hubC = spawnHub(PC, { extraEnv: { RELAY_CLAIM_TTL_MS: "1200" } });
let errC = ""; hubC.stderr.on("data", d => errC += d);
await sleep(800);
try {
  const C = mk(`http://127.0.0.1:${PC}`); const PROJ = "evtC";
  await C.post("/register", { session: "host:evtC", project: PROJ, status: "reading" });
  await C.post("/task", { project: PROJ, title: "a card so /history has something", by: "host:evtC", status: "doing" });

  const bad = await C.post("/read", { project: PROJ, file: "lib/a.mjs" });
  ok("/read without a session is refused", !!bad.error, JSON.stringify(bad));

  await C.post("/read", { project: PROJ, file: "lib/a.mjs", session: "host:evtC", seat: "glm" });
  await C.post("/read", { project: PROJ, file: "lib/a.mjs", session: "host:evtC", seat: "glm" });
  const reads = (await C.get(`/events?project=${PROJ}&type=file.read`)).events;
  ok("two posts inside the window append ONE file.read", reads.length === 1, `(got ${reads.length})`);
  ok("the event carries file, seat and the reader session", reads[0]?.file === "lib/a.mjs" && reads[0]?.seat === "glm" && reads[0]?.by === "host:evtC", JSON.stringify(reads[0] || {}));

  await C.post("/read", { project: PROJ, file: "lib/b.mjs", session: "host:evtC", seat: "glm" });
  const perFile = (await C.get(`/events?project=${PROJ}&type=file.read`)).events;
  ok("the throttle is keyed per file", perFile.length === 2 && perFile.some(e => e.file === "lib/b.mjs"), `(got ${perFile.length})`);

  await sleep(1500);
  await C.post("/read", { project: PROJ, file: "lib/a.mjs", session: "host:evtC", seat: "glm" });
  const reads2 = (await C.get(`/events?project=${PROJ}&type=file.read`)).events;
  ok("a third post AFTER the window appends another", reads2.length === 3 && reads2[2]?.file === "lib/a.mjs", `(got ${reads2.length})`);

  const hist = (await C.get(`/history?project=${PROJ}`)).events;
  ok("/history never carries file.read", hist.every(e => e.type !== "file.read"), `(got ${hist.map(e => e.type)})`);
  ok("/history still serves its card events", hist.some(e => e.type === "created"));
} finally { hubC.kill(); }
ok("hub C clean stderr", !/TypeError|ReferenceError|not defined/.test(errC), errC.slice(0, 300));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
