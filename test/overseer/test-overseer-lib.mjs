#!/usr/bin/env node
import assert from "node:assert/strict";
import { detectCollisions, levelFor } from "../../lib/overseer.mjs";

let pass = 0, fail = 0;
const ok = (condition, name) => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
};

async function test(name, fn) {
  try {
    await fn();
    ok(true, name);
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
}

const now = 1_000_000;
const live = (session, project, ageMs = 0) => ({ session, project, lastSeen: now - ageMs, llm: "codex", model: "gpt-5", status: "ready" });
const claim = (session, project, file, ageMs = 0) => ({ session, project, file, ts: now - ageMs });

console.log("# overseer pure library tests");

await test("levelFor uses project key, then wildcard, then level 1", () => {
  assert.equal(levelFor("alpha", { alpha: 3, "*": 2 }), 3);
  assert.equal(levelFor("beta", { alpha: 3, "*": 2 }), 2);
  assert.equal(levelFor("beta", { alpha: 3 }), 1);
  assert.equal(levelFor("beta", { beta: 9, "*": 4 }), 4);
});

await test("empty and missing inputs produce no collisions", () => {
  assert.deepEqual(detectCollisions({ now }), []);
  assert.deepEqual(detectCollisions(), []);
});

await test("same-project-sessions reports one sorted collision per project", () => {
  const collisions = detectCollisions({
    now,
    peers: [
      live("zeta:alpha", "alpha"),
      live("host:alpha", "alpha"),
      live("old:alpha", "alpha", 5 * 60 * 1000 + 1),
      live("solo:beta", "beta"),
    ],
  });
  assert.deepEqual(collisions, [{
    project: "alpha",
    kind: "same-project-sessions",
    sessions: ["host:alpha", "zeta:alpha"],
    files: [],
    detail: "host:alpha, zeta:alpha are live on project alpha.",
  }]);
});

await test("file-conflict reports live claims by different sessions on the same project/file", () => {
  const collisions = detectCollisions({
    now,
    claims: [
      claim("codex:alpha", "alpha", "src/a.ts"),
      claim("codex:alpha", "alpha", "src/a.ts", 1),
      claim("kimi:alpha", "alpha", "src/a.ts"),
      claim("old:alpha", "alpha", "src/a.ts", 10 * 60 * 1000 + 1),
      claim("other:alpha", "alpha", "src/b.ts"),
      claim("samepath:beta", "beta", "src/a.ts"),
    ],
  });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].kind, "file-conflict");
  assert.deepEqual(collisions[0].sessions, ["codex:alpha", "kimi:alpha"]);
  assert.deepEqual(collisions[0].files, ["src/a.ts"]);
  assert.equal(collisions[0].detail, "codex:alpha, kimi:alpha have live claims on alpha/src/a.ts.");
});

// THE NEGATIVE CASE — the reason #7029 exists, and the one the fix is FOR.
// The old detector warned because two sessions were LIVE on linked projects. On this machine that
// is the permanent condition (trantor and trantor-duty are declared codependent), so it fired
// constantly, woke a seat each time, and cost a full turn proving a negative. Presence is a STATE;
// a warning needs an EVENT. Without this test the whole card is unverified: deleting the
// `evidence.length === 0` guard leaves every other assertion green.
await test("co-presence on linked projects with NO overlap is SILENT", () => {
  const collisions = detectCollisions({
    now,
    // Both live, both busy, both on linked projects — exactly the standing condition.
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    // Each holds its OWN file. Nothing is contended.
    claims: [
      claim("a:alpha", "alpha", "src/mine.ts"),
      claim("b:bravo", "bravo", "src/theirs.ts"),
    ],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  assert.deepEqual(
    collisions.filter((c) => c.kind === "linked-activity"), [],
    "presence alone must never raise linked-activity",
  );
});

await test("co-presence with NO claims at all is SILENT", () => {
  // The barest version: two live sessions on linked projects, touching nothing.
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    claims: [],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  assert.deepEqual(collisions.filter((c) => c.kind === "linked-activity"), []);
});

await test("linked-activity fires on one FILE PATH claimed from both sides of the link", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    claims: [
      claim("a:alpha", "alpha", "src/schema.ts"),
      claim("b:bravo", "bravo", "src/schema.ts"),
      claim("a:alpha", "alpha", "src/only-mine.ts"),
    ],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  const linked = collisions.find((c) => c.kind === "linked-activity");
  assert.equal(linked.project, "alpha");
  assert.deepEqual(linked.sessions, ["a:alpha", "b:bravo"]);
  assert.deepEqual(linked.files, ["src/schema.ts"]);
  assert.equal(linked.detail, "Linked projects alpha, bravo are on the same work: src/schema.ts is claimed by a:alpha, b:bravo.");
});

await test("linked-activity fires on one CARD held by live sessions from both sides", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    cards: [
      { id: 7029, project: "alpha", status: "doing", assignee: "a:alpha", workedBy: "b:bravo" },
      { id: 7030, project: "alpha", status: "doing", assignee: "a:alpha", workedBy: "a:alpha" },
    ],
    links: [{ projects: ["alpha", "bravo"], reason: "codependent" }],
  });
  const linked = collisions.find((c) => c.kind === "linked-activity");
  assert.deepEqual(linked.sessions, ["a:alpha", "b:bravo"]);
  assert.deepEqual(linked.files, []);
  assert.equal(linked.detail, "Linked projects alpha, bravo are on the same work: card #7029 is held by a:alpha, b:bravo.");
});

// Regression (#7029, 2026-09-09): the warning fired because two sessions were LIVE on linked
// projects — a STATE, and on a machine with a declared codependence the PERMANENT state. It woke a
// seat, which spent a full turn proving nothing overlapped. Presence is not evidence; an event is.
await test("linked-activity stays silent when both sides work but nothing is shared", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    claims: [claim("a:alpha", "alpha", "src/a.ts"), claim("b:bravo", "bravo", "src/b.ts")],
    cards: [
      { id: 1, project: "alpha", status: "doing", assignee: "a:alpha", workedBy: "a:alpha" },
      { id: 2, project: "bravo", status: "testing", assignee: "b:bravo", workedBy: "b:bravo" },
    ],
    links: [{ projects: ["alpha", "bravo"], reason: "codependent" }],
  });
  assert.equal(collisions.find((c) => c.kind === "linked-activity"), undefined);
});

await test("linked-activity ignores linked projects whose sessions are merely online", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  assert.equal(collisions.find((c) => c.kind === "linked-activity"), undefined);
});

await test("linked-activity ignores queued cards, dead holders, and one-sided evidence", () => {
  const linkedOf = (input) => detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo")],
    links: [{ projects: ["alpha", "bravo"] }],
    ...input,
  }).find((c) => c.kind === "linked-activity");
  // a card nobody has picked up yet is not held
  assert.equal(linkedOf({ cards: [{ id: 9, project: "alpha", status: "todo", assignee: "a:alpha", workedBy: "b:bravo" }] }), undefined);
  // a finished card is nobody's hands
  assert.equal(linkedOf({ cards: [{ id: 9, project: "alpha", status: "done", assignee: "a:alpha", workedBy: "b:bravo" }] }), undefined);
  // the second holder went home — one live session is not a collision
  assert.equal(linkedOf({ cards: [{ id: 9, project: "alpha", status: "doing", assignee: "a:alpha", workedBy: "gone:bravo" }] }), undefined);
  // both holders live but in the SAME project: an orchestrator filing and a seat working is the
  // normal shape of a card, not a cross-project collision
  assert.equal(detectCollisions({
    now,
    peers: [live("orch:alpha", "alpha"), live("seat:alpha", "alpha"), live("b:bravo", "bravo")],
    cards: [{ id: 9, project: "alpha", status: "doing", assignee: "orch:alpha", workedBy: "seat:alpha" }],
    links: [{ projects: ["alpha", "bravo"] }],
  }).find((c) => c.kind === "linked-activity"), undefined);
  // a stale claim on one side leaves the path claimed by one live session only
  assert.equal(linkedOf({ claims: [claim("a:alpha", "alpha", "s.ts"), claim("b:bravo", "bravo", "s.ts", 10 * 60 * 1000 + 1)] }), undefined);
  // a path claimed twice from ONE side of the link is a file-conflict, not a linked-activity
  assert.equal(linkedOf({ claims: [claim("a:alpha", "alpha", "s.ts"), claim("a2:alpha", "alpha", "s.ts")] }), undefined);
});

await test("linked-activity reports one collision per link, evidence and all", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo"), live("c:charlie", "charlie")],
    claims: [
      claim("a:alpha", "alpha", "z.ts"),
      claim("b:bravo", "bravo", "z.ts"),
      claim("c:charlie", "charlie", "y.ts"),
      claim("a:alpha", "alpha", "y.ts"),
    ],
    cards: [{ id: 42, project: "alpha", status: "testing", assignee: "a:alpha", workedBy: "b:bravo" }],
    links: [{ projects: ["charlie", "alpha", "bravo"], reason: "shared release" }],
  });
  const linked = collisions.filter((c) => c.kind === "linked-activity");
  assert.equal(linked.length, 1);
  assert.deepEqual(linked[0].files, ["y.ts", "z.ts"]);
  assert.deepEqual(linked[0].sessions, ["a:alpha", "b:bravo", "c:charlie"]);
  assert.equal(linked[0].detail,
    "Linked projects alpha, bravo, charlie are on the same work: y.ts is claimed by a:alpha, c:charlie; z.ts is claimed by a:alpha, b:bravo; card #42 is held by a:alpha, b:bravo.");
});

await test("deduplicates duplicate peers, claims, and links", () => {
  const input = {
    now,
    peers: [live("a:p", "p"), live("a:p", "p"), live("b:p", "p")],
    claims: [claim("a:p", "p", "x.js"), claim("a:p", "p", "x.js"), claim("b:p", "p", "x.js"), claim("q:q", "q", "x.js")],
    links: [
      { projects: ["p", "q"] },
      { projects: ["q", "p", "p"] },
    ],
  };
  const withLink = detectCollisions({ ...input, peers: [...input.peers, live("q:q", "q")] });
  assert.equal(withLink.filter((c) => c.kind === "same-project-sessions").length, 1);
  assert.equal(withLink.filter((c) => c.kind === "file-conflict").length, 1);
  assert.equal(withLink.filter((c) => c.kind === "linked-activity").length, 1);
});

await test("orders by project, kind, first file, then first session", () => {
  const collisions = detectCollisions({
    now,
    peers: [
      live("z:zeta", "zeta"),
      live("a:zeta", "zeta"),
      live("b:alpha", "alpha"),
      live("a:alpha", "alpha"),
      live("m:beta", "beta"),
    ],
    claims: [
      claim("x:zeta", "zeta", "b.ts"),
      claim("y:zeta", "zeta", "b.ts"),
      claim("x:alpha", "alpha", "a.ts"),
      claim("y:alpha", "alpha", "a.ts"),
      claim("m:beta", "beta", "b.ts"),
    ],
    links: [{ projects: ["beta", "zeta"] }],
  });
  assert.deepEqual(collisions.map((c) => `${c.project}:${c.kind}:${c.files[0] ?? ""}:${c.sessions[0]}`), [
    "alpha:file-conflict:a.ts:x:alpha",
    "alpha:same-project-sessions::a:alpha",
    "beta:linked-activity:b.ts:m:beta",
    "zeta:file-conflict:b.ts:x:zeta",
    "zeta:same-project-sessions::a:zeta",
  ]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
