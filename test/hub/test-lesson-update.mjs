#!/usr/bin/env node
// A stale global lesson (lesson #53 told every seat never to commit) can be rewritten in place by a
// global owner, never by anyone else, and the old text stays on the lesson as a revision.
import "../isolate-bus.mjs";
import { loadOrCreate } from "../../lib/identity.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

console.log("# lesson update");
const hub = await startTestHub({ env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
try {
  const owner = loadOrCreate("lesson-owner", "human");
  const seat = loadOrCreate("lesson-seat");
  await sfetchJson(`${hub.base}/enroll`, { identity: owner, payload: { name: owner.name, kind: "human", scopes: [{ project: "*", role: "owner" }] } });
  await sfetchJson(`${hub.base}/enroll`, { identity: seat, payload: { name: seat.name, kind: "agent", scopes: [{ project: "lessons", role: "write" }] } });
  const post = async (identity, path, payload) => {
    const r = await sfetchJson(`${hub.base}${path}`, { identity, payload });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  await post(owner, "/lesson", { text: "Crew members must NEVER commit", scope: "global", by: owner.name });
  const id = 1;
  const asSeat = await post(seat, "/lesson/update", { id, text: "seats rewrite lessons", by: seat.name });
  ok("a non-owner is refused", asSeat.status === 403, JSON.stringify(asSeat));
  const missing = await post(owner, "/lesson/update", { id: 999, text: "x", by: owner.name });
  ok("an unknown lesson id is a 404", missing.status === 404, JSON.stringify(missing));
  const empty = await post(owner, "/lesson/update", { id, text: "   ", by: owner.name });
  ok("empty text is refused", empty.status === 400, JSON.stringify(empty));

  const done = await post(owner, "/lesson/update", { id, text: "Seats commit only their own card's files, by explicit path", by: owner.name });
  const body = done.body;
  ok("the owner rewrites it", done.status === 200 && body.lesson?.text === "Seats commit only their own card's files, by explicit path", JSON.stringify(done));
  ok("the id is kept", body.lesson?.id === id);
  ok("the old text survives as a revision", body.lesson?.revisions?.[0]?.text === "Crew members must NEVER commit");
  const listed = await sfetchJson(`${hub.base}/lessons`, { method: "GET", identity: owner });
  const lessons = (await listed.json()).lessons || [];
  ok("GET /lessons serves the new text", lessons.some(l => l.id === id && l.text.startsWith("Seats commit")), JSON.stringify(lessons).slice(0, 200));
} finally {
  await hub.stop?.();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
