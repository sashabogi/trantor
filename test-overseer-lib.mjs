#!/usr/bin/env node
import assert from "node:assert/strict";
import { detectCollisions, levelFor } from "./lib/overseer.mjs";

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

await test("linked-activity reports one collision for a declared active link", () => {
  const collisions = detectCollisions({
    now,
    peers: [
      live("b:bravo", "bravo"),
      live("a:alpha", "alpha"),
      live("c:charlie", "charlie"),
      live("stale:delta", "delta", 5 * 60 * 1000 + 1),
    ],
    links: [
      { projects: ["delta", "alpha"], reason: "stale side" },
      { projects: ["charlie", "alpha", "bravo"], reason: "shared release" },
    ],
  });
  const linked = collisions.find((c) => c.kind === "linked-activity");
  assert.equal(linked.project, "alpha");
  assert.deepEqual(linked.sessions, ["a:alpha", "b:bravo", "c:charlie"]);
  assert.deepEqual(linked.files, []);
  assert.equal(linked.detail, "Linked projects alpha, bravo, charlie are being worked on at the same time by a:alpha, b:bravo, c:charlie.");
});

// Regression (2026-08-12): linked-activity used to fire on mere PRESENCE, so two linked projects
// with idle-but-online sessions warned every dedup window forever — 468 identical events in 8 days.
// A link is DECLARED; restating it is not a collision. Only CONCURRENT WORK counts: a peer inside
// the 90s work window, or a fresh file claim.
await test("linked-activity ignores linked projects whose sessions are merely online, not working", () => {
  const idle = (session, project) => live(session, project, 3 * 60 * 1000);   // online (<5m), not working (>90s)
  const collisions = detectCollisions({
    now,
    peers: [idle("a:alpha", "alpha"), idle("b:bravo", "bravo")],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  assert.equal(collisions.find((c) => c.kind === "linked-activity"), undefined);
});

await test("linked-activity fires when a linked project's work is proven by a fresh file claim", () => {
  const collisions = detectCollisions({
    now,
    peers: [live("a:alpha", "alpha"), live("b:bravo", "bravo", 3 * 60 * 1000)],
    claims: [{ project: "bravo", file: "src/schema.ts", session: "b:bravo", ts: now - 1000 }],
    links: [{ projects: ["alpha", "bravo"], reason: "shared schema" }],
  });
  const linked = collisions.find((c) => c.kind === "linked-activity");
  assert.ok(linked, "a fresh claim proves work even when the heartbeat is older than the work window");
  assert.deepEqual(linked.sessions, ["a:alpha", "b:bravo"]);
});

await test("deduplicates duplicate peers, claims, and links", () => {
  const input = {
    now,
    peers: [live("a:p", "p"), live("a:p", "p"), live("b:p", "p")],
    claims: [claim("a:p", "p", "x.js"), claim("a:p", "p", "x.js"), claim("b:p", "p", "x.js")],
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
    ],
    links: [{ projects: ["beta", "zeta"] }],
  });
  assert.deepEqual(collisions.map((c) => `${c.project}:${c.kind}:${c.files[0] ?? ""}:${c.sessions[0]}`), [
    "alpha:file-conflict:a.ts:x:alpha",
    "alpha:same-project-sessions::a:alpha",
    "beta:linked-activity::a:zeta",
    "zeta:file-conflict:b.ts:x:zeta",
    "zeta:same-project-sessions::a:zeta",
  ]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
