#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseRepoUrl, detectRepo, createRemoteOverlap } from "../../lib/remote-overlap.mjs";
import { detectCollisions } from "../../lib/overseer.mjs";

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

const NOW = 1_000_000;

// A fake gh: the injected runner contract is (args) -> { code, stdout, stderr }, exactly what the
// default execFile wrapper resolves. No network, no spawn — fixtures are inline JSON.
const listJson = (prs) => JSON.stringify(
  prs.map(({ number, login = "alice", url }) => ({
    number,
    user: { login },
    html_url: url ?? `https://github.com/acme/widgets/pull/${number}`,
  }))
);
const filesJson = (files) => JSON.stringify(files.map((filename) => ({ filename })));

function fakeGh(opts = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    const path = String(args[1] ?? "");
    if (path.endsWith("/pulls?state=open")) return opts.listError ?? { code: 0, stdout: listJson(opts.list ?? []), stderr: "" };
    const m = path.match(/pulls\/(\d+)\/files$/);
    if (m) {
      const n = Number(m[1]);
      return opts.fileErrors?.[n] ?? { code: 0, stdout: filesJson(opts.filesByPr?.[n] ?? []), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected path ${path}` };
  };
  return { run, calls, opts };
}

const tick = () => new Promise((r) => setImmediate(r));

console.log("# remote-overlap tests");

await test("parseRepoUrl reads the remote forms in the wild and rejects the rest", () => {
  assert.equal(parseRepoUrl("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepoUrl("ssh://git@github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepoUrl("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(parseRepoUrl("https://x-access-token:ghp_x@github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepoUrl("acme/widgets"), "acme/widgets");
  assert.equal(parseRepoUrl("git@gitlab.com:acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepoUrl(""), null);
  assert.equal(parseRepoUrl(null), null);
  assert.equal(parseRepoUrl("https://github.com/acme"), null);
  assert.equal(parseRepoUrl("not a url"), null);
});

await test("detectRepo parses origin, and null on no-origin or failure", () => {
  assert.equal(detectRepo({ run: (args, { cwd } = {}) => {
    assert.equal(args.join(" "), "remote get-url origin");
    assert.equal(cwd, "/repo");
    return { status: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
  }, dir: "/repo" }), "acme/widgets");
  assert.equal(detectRepo({ run: () => ({ status: 1, stdout: "", stderr: "not a repo" }) }), null);
  assert.equal(detectRepo({ run: () => { throw new Error("spawn git ENOENT"); } }), null);
});

await test("overlap match: a PR touching a wanted file reports pr, author, url and the intersected files", async () => {
  const gh = fakeGh({ list: [{ number: 7 }, { number: 9 }], filesByPr: { 7: ["src/x.ts", "src/y.ts"], 9: ["docs/a.md"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW });
  await api.refresh("acme/widgets");
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts", "src/z.ts"]), [{
    pr: 7,
    author: "alice",
    url: "https://github.com/acme/widgets/pull/7",
    files: ["src/x.ts"],
  }]);
  assert.deepEqual(api.overlapsFor("acme/widgets", []), []);
  assert.deepEqual(api.overlapsFor(null, ["src/x.ts"]), []);
});

await test("cache hit: a poll inside the TTL makes no new gh calls", async () => {
  const gh = fakeGh({ list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW });
  await api.refresh("acme/widgets");
  const afterFirst = gh.calls.length;
  await api.refresh("acme/widgets");
  api.overlapsFor("acme/widgets", ["src/x.ts"]);
  assert.equal(gh.calls.length, afterFirst, "TTL-fresh reads must not re-poll");
});

await test("cache miss: past the TTL overlapsFor serves stale and kicks exactly one refresh", async () => {
  let at = NOW;
  const gh = fakeGh({ list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => at });
  await api.refresh("acme/widgets");
  const afterFirst = gh.calls.length;
  at = NOW + 5 * 60 * 1000 + 1;
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]).length, 1, "stale data still answers synchronously");
  await tick();
  assert.ok(gh.calls.length > afterFirst, "a stale read kicks a background refresh");
  await api.refresh("acme/widgets");
  const afterSecond = gh.calls.length;
  await tick();
  assert.equal(gh.calls.length, afterSecond, "concurrent kicks dedupe into one poll");
});

await test("per-PR files failure is contained: that PR contributes nothing, the rest survive", async () => {
  const gh = fakeGh({ list: [{ number: 7 }, { number: 8 }], filesByPr: { 8: ["src/x.ts"] }, fileErrors: { 7: { code: 1, stdout: "", stderr: "boom" } } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW });
  await api.refresh("acme/widgets");
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]).map((o) => o.pr), [8]);
});

await test("gh missing: off with one log line, no raise, no further calls, forever empty", async () => {
  const logs = [];
  const gh = fakeGh({ listError: { code: "ENOENT", stdout: "", stderr: "spawn gh ENOENT" } });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => NOW });
  assert.equal(await api.refresh("acme/widgets"), null);
  assert.equal(api.enabled, false);
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]), []);
  await api.refresh("acme/widgets");
  await tick();
  assert.equal(logs.length, 1, `one log line, got ${logs.length}`);
  assert.equal(gh.calls.length, 1, "a turned-off poller never calls gh again");
});

await test("gh unauthenticated: same off-with-one-line behavior", async () => {
  const logs = [];
  const gh = fakeGh({ listError: { code: 4, stdout: "", stderr: "gh: To get started with GitHub CLI, please run: gh auth login" } });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => NOW });
  await api.refresh("acme/widgets");
  assert.equal(api.enabled, false);
  assert.equal(logs.length, 1);
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]), []);
});

await test("rate limit: pause with one log line, serve stale, resume after the backoff", async () => {
  let at = NOW;
  const logs = [];
  const gh = fakeGh({ list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => at });
  await api.refresh("acme/widgets");
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]).length, 1);
  const goodCalls = gh.calls.length;
  gh.opts.list = [{ number: 8 }];
  gh.opts.listError = { code: 1, stdout: "", stderr: "gh: API rate limit exceeded for user ID 123." };
  at = NOW + 6 * 60 * 1000;
  const served = await api.refresh("acme/widgets");
  assert.deepEqual(served?.prs.map((o) => o.pr), [7], "rate-limited poll serves the stale cache");
  assert.equal(api.enabled, true, "a rate limit is not an outage");
  assert.equal(logs.length, 1);
  const blockedCalls = gh.calls.length;
  await api.refresh("acme/widgets");
  assert.equal(gh.calls.length, blockedCalls, "blocked poller makes no calls");
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]).map((o) => o.pr), [7], "stale evidence stays in use");
  at = NOW + 17 * 60 * 1000;
  gh.opts.listError = null;
  gh.opts.filesByPr[8] = ["src/x.ts"];
  await api.refresh("acme/widgets");
  assert.ok(gh.calls.length > blockedCalls, "polling resumes after the backoff");
  // PR 7 closed and dropped off the list while paused; only PR 8 remains.
  assert.deepEqual(api.overlapsFor("acme/widgets", ["src/x.ts"]).map((o) => o.pr), [8]);
});

await test("detector: one remote-overlap collision per (pr, file) with claimants as sessions", () => {
  const claim = (session, project, file, age = 0) => ({ session, project, file, ts: NOW - age });
  const overlap = (files) => ({ pr: 7, author: "alice", url: "https://github.com/acme/widgets/pull/7", files });
  const collisions = detectCollisions({
    now: NOW,
    claims: [
      claim("glm:trantor", "trantor", "src/x.ts"),
      claim("codex:trantor", "trantor", "src/x.ts"),
      claim("glm:trantor", "trantor", "src/y.ts"),
    ],
    remoteOverlaps: [overlap(["src/x.ts", "src/y.ts", "src/untouched.ts"])],
  });
  const remote = collisions.filter((c) => c.kind === "remote-overlap");
  assert.equal(remote.length, 2, "one per (pr, file), untouched file has no claimant");
  const x = remote.find((c) => c.files[0] === "src/x.ts");
  const y = remote.find((c) => c.files[0] === "src/y.ts");
  assert.deepEqual(x.sessions, ["codex:trantor", "glm:trantor"]);
  assert.equal(x.project, "trantor");
  assert.equal(x.detail, "open PR #7 by alice also changes src/x.ts (https://github.com/acme/widgets/pull/7).");
  assert.deepEqual(y.sessions, ["glm:trantor"]);
});

await test("detector: closed PR ends the episode, stale claims and PR-less files stay silent", () => {
  const claim = (session, project, file, age = 0) => ({ session, project, file, ts: NOW - age });
  const overlap = (files) => ({ pr: 7, author: "alice", url: "", files });
  const open = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts")],
    remoteOverlaps: [overlap(["src/x.ts"])],
  }).filter((c) => c.kind === "remote-overlap");
  assert.equal(open.length, 1);
  // The PR closed: the next poll drops it, so the evidence input carries it no more.
  const closed = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts")],
    remoteOverlaps: [],
  }).filter((c) => c.kind === "remote-overlap");
  assert.deepEqual(closed, [], "no PR evidence, no collision — the episode ends");
  assert.deepEqual(detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", 10 * 60 * 1000 + 1)],
    remoteOverlaps: [overlap(["src/x.ts"])],
  }).filter((c) => c.kind === "remote-overlap"), [], "a stale claim is nobody editing");
  assert.deepEqual(detectCollisions({
    now: NOW,
    claims: [],
    remoteOverlaps: [overlap(["src/x.ts"])],
  }).filter((c) => c.kind === "remote-overlap"), [], "a PR over files nobody claims is silent");
});

await test("detector: remote-overlap never leaks into other kinds and tolerates junk input", () => {
  const collisions = detectCollisions({
    now: NOW,
    claims: [{ session: "s:p", project: "p", file: "f.ts", ts: NOW }],
    remoteOverlaps: [null, {}, { pr: "nope", files: ["f.ts"] }, { pr: 3, files: [] }],
  });
  assert.deepEqual(collisions, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
