#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepoUrl, detectRepo, createRemoteOverlap } from "../../lib/remote-overlap.mjs";
import { detectCollisions, collisionIdentity } from "../../lib/overseer.mjs";

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
// scratch stays inside the worktree, under the gitignored out-dir
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const scratch = () => mkdtempSync(join(ROOT, ".agent-bus-out", "ro-"));

// A fake gh: the injected runner contract is (args) -> { code, stdout, stderr }, sync like the
// default spawnSync wrapper. No network, no spawn — fixtures are inline JSON.
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
  const run = (args) => {
    calls.push(args.join(" "));
    const path = String(args[1] ?? "");
    const rm = path.match(/^repos\/([^/]+\/[^/]+)\/pulls/);
    // repo-aware: a fixture answers ONLY for its own repo — any other repo sees an empty list
    if (rm && opts.repo && rm[1] !== opts.repo) return { code: 0, stdout: "[]", stderr: "" };
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

const ENOENT = { code: "ENOENT", stdout: "", stderr: "spawn gh ENOENT" };

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

await test("overlap match: PR touching a wanted file reports repo, number, author, url, intersected files", () => {
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }, { number: 9 }], filesByPr: { 7: ["src/x.ts", "src/y.ts"], 9: ["docs/a.md"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW, cacheDir: scratch() });
  const out = api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts", "src/z.ts"] });
  assert.deepEqual(out, [{
    repo: "acme/widgets",
    number: 7,
    author: "alice",
    url: "https://github.com/acme/widgets/pull/7",
    files: ["src/x.ts"],
  }]);
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: [] }), []);
  assert.deepEqual(api.overlapsFor({ files: ["src/x.ts"] }), []);
});

await test("cache hit and miss: poll once per TTL window, file cache carries it across instances", () => {
  const dir = scratch();
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW, cacheDir: dir });
  api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  const afterFirst = gh.calls.length;
  api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  assert.equal(gh.calls.length, afterFirst, "TTL-fresh reads make no gh calls");
  assert.ok(existsSync(join(dir, "remote-overlap-acme-widgets.json")), "cache file written");

  // a second instance (the next hook process) reads the SAME warm file with zero gh calls
  const gh2 = fakeGh({});
  const api2 = createRemoteOverlap({ run: gh2.run, now: () => NOW, cacheDir: dir });
  assert.deepEqual(api2.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).map((o) => o.number), [7]);
  assert.equal(gh2.calls.length, 0, "warm cache file answers with no poll");

  // past the TTL the poll reruns (cache miss)
  const api3 = createRemoteOverlap({ run: gh.run, now: () => NOW + 5 * 60 * 1000 + 1, cacheDir: dir });
  api3.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  assert.ok(gh.calls.length > afterFirst, "stale cache triggers a fresh poll");
});

await test("an unrelated repo never matches: its own cache is polled, never another repo's", () => {
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW, cacheDir: scratch() });
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).length, 1);
  const before = gh.calls.length;
  assert.deepEqual(api.overlapsFor({ repo: "other/repo", files: ["src/x.ts"] }), [], "no PRs in other/repo at all");
  assert.ok(gh.calls.length > before, "other/repo got its own poll");
  assert.ok(!gh.calls.some((c) => c.includes("other/repo/pulls/")), "no cross-repo reads");
});

await test("gitRoot scoping: repo is derived from the checkout the session actually edits", () => {
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const gitRun = (args, { cwd } = {}) =>
    cwd === "/wt/glm"
      ? { status: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "not a repo" };
  const api = createRemoteOverlap({ run: gh.run, gitRun, now: () => NOW, cacheDir: scratch() });
  assert.deepEqual(api.overlapsFor({ gitRoot: "/wt/glm", files: ["src/x.ts"] }).map((o) => o.repo), ["acme/widgets"]);
  assert.deepEqual(api.overlapsFor({ gitRoot: "/elsewhere", files: ["src/x.ts"] }), [], "no origin, no evidence");
  assert.deepEqual(api.overlapsFor({ gitRoot: null, files: ["src/x.ts"] }), []);
});

await test("gh missing means off: one log line, empty forever, no more gh calls", () => {
  const logs = [];
  const gh = fakeGh({ repo: "acme/widgets", listError: ENOENT });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => NOW, cacheDir: scratch() });
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }), []);
  assert.equal(api.enabled, false);
  api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  assert.equal(logs.length, 1, `one log line, got ${logs.length}`);
  assert.equal(gh.calls.length, 1, "a turned-off poller never calls gh again");
});

await test("gh unauthenticated: same off-with-one-line behavior", () => {
  const logs = [];
  const gh = fakeGh({ repo: "acme/widgets", listError: { code: 4, stdout: "", stderr: "gh: To get started with GitHub CLI, please run: gh auth login" } });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => NOW, cacheDir: scratch() });
  api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  assert.equal(api.enabled, false);
  assert.equal(logs.length, 1);
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }), []);
});

await test("rate limit: backoff persisted in the cache, stale evidence served, poll resumes later", () => {
  let at = NOW;
  const logs = [];
  const dir = scratch();
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, log: (m) => logs.push(m), now: () => at, cacheDir: dir });
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).length, 1);
  const goodCalls = gh.calls.length;
  gh.opts.list = [{ number: 7 }, { number: 8 }];
  gh.opts.listError = { code: 1, stdout: "", stderr: "gh: API rate limit exceeded for user ID 123." };
  at = NOW + 6 * 60 * 1000;
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).map((o) => o.number), [7],
    "rate-limited poll serves the stale cache");
  assert.equal(api.enabled, true, "a rate limit is not an outage");
  assert.equal(logs.length, 1);
  const blockedCalls = gh.calls.length;
  // a SIBLING process (new instance, same cache file) must honor the persisted backoff
  const api2 = createRemoteOverlap({ run: gh.run, log: () => {}, now: () => at, cacheDir: dir });
  api2.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] });
  assert.equal(gh.calls.length, blockedCalls, "backoff survives the process boundary");
  at = NOW + 17 * 60 * 1000;
  gh.opts.listError = null;
  gh.opts.filesByPr[8] = ["src/x.ts"];
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).map((o) => o.number), [7, 8],
    "polling resumes after the backoff");
  assert.ok(gh.calls.length > blockedCalls);
});

await test("closed PR ends it: dropped from the open list, next poll stops matching", () => {
  let at = NOW;
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }], filesByPr: { 7: ["src/x.ts"] } });
  const api = createRemoteOverlap({ run: gh.run, now: () => at, cacheDir: scratch() });
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).length, 1);
  at = NOW + 5 * 60 * 1000 + 1;
  gh.opts.list = [];
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }), [], "PR 7 closed, no more evidence");
});

await test("per-PR files failure is contained: that PR contributes nothing, the rest survive", () => {
  const gh = fakeGh({ repo: "acme/widgets", list: [{ number: 7 }, { number: 8 }], filesByPr: { 8: ["src/x.ts"] }, fileErrors: { 7: { code: 1, stdout: "", stderr: "boom" } } });
  const api = createRemoteOverlap({ run: gh.run, now: () => NOW, cacheDir: scratch() });
  assert.deepEqual(api.overlapsFor({ repo: "acme/widgets", files: ["src/x.ts"] }).map((o) => o.number), [8]);
});

const claim = (session, project, file, extra = {}) =>
  ({ session, project, file, ts: NOW, ...extra });
const remote7 = (files = ["src/x.ts"]) => ({ repo: "acme/widgets", number: 7, author: "alice", url: "https://github.com/acme/widgets/pull/7", files });

await test("detector: claim.remote yields one remote-overlap collision per (repo, pr, file)", () => {
  const collisions = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7()] })],
  });
  const remote = collisions.filter((c) => c.kind === "remote-overlap");
  assert.equal(remote.length, 1);
  assert.equal(remote[0].repo, "acme/widgets");
  assert.equal(remote[0].pr, 7);
  assert.deepEqual(remote[0].sessions, ["glm:trantor"]);
  assert.equal(remote[0].gitRoot, "/wt/glm");
  assert.equal(remote[0].detail, "open PR #7 by alice in acme/widgets also changes src/x.ts (https://github.com/acme/widgets/pull/7).");
});

await test("two PRs on one file are TWO episodes: distinct collisionIdentity per (repo, pr, file)", () => {
  const collisions = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7(), { ...remote7(), number: 8, author: "bob" }] })],
  }).filter((c) => c.kind === "remote-overlap");
  assert.equal(collisions.length, 2);
  const ids = collisions.map(collisionIdentity);
  assert.equal(new Set(ids).size, 2, `identities must differ: ${ids.join(" | ")}`);
  assert.ok(ids[0].includes("acme/widgets#7") && ids.some((i) => i.includes("acme/widgets#8")));
});

await test("sessions are PROJECT-scoped: same project+file joins across checkouts, other projects never do", () => {
  const withEvidence = claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7()] });
  // same project, same file, different checkout: joins the episode's sessions (project is the scope)
  const sameProjectOtherCheckout = claim("codex:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/codex", remote: [] });
  const collisions = detectCollisions({ now: NOW, claims: [withEvidence, sameProjectOtherCheckout] })
    .filter((c) => c.kind === "remote-overlap");
  assert.equal(collisions.length, 1, "a claim with no remote raises no episode of its own");
  assert.deepEqual(collisions[0].sessions, ["codex:trantor", "glm:trantor"]);
  // a DIFFERENT project claiming the same path stays out of sessions entirely
  const otherProject = claim("kimi:elsewhere", "elsewhere", "src/x.ts", { gitRoot: "/wt/glm", remote: [] });
  const withElsewhere = detectCollisions({ now: NOW, claims: [withEvidence, otherProject] })
    .filter((c) => c.kind === "remote-overlap");
  assert.deepEqual(withElsewhere[0].sessions, ["glm:trantor"], "another project is not a participant");
});

await test("same gitRoot, different projects: TWO episodes — identity and sessions stay project-scoped", () => {
  // one worktree checked out by two projects (the exact merge codex flagged)
  const alpha = claim("glm:alpha", "alpha", "src/x.ts", { gitRoot: "/shared/wt", remote: [remote7()] });
  const beta = claim("kimi:beta", "beta", "src/x.ts", { gitRoot: "/shared/wt", remote: [remote7()] });
  const collisions = detectCollisions({ now: NOW, claims: [alpha, beta] })
    .filter((c) => c.kind === "remote-overlap");
  assert.equal(collisions.length, 2, "one episode per project, never merged by the shared gitRoot");
  const ids = collisions.map(collisionIdentity);
  assert.equal(new Set(ids).size, 2, `identities must differ by project: ${ids.join(" | ")}`);
  assert.ok(ids.every((i) => /^(alpha|beta) remote-overlap /.test(i) && i.includes("acme/widgets#7")),
    `remote identity is project-keyed with repo#pr: ${ids.join(" | ")}`);
  assert.deepEqual(collisions.find((c) => c.project === "alpha").sessions, ["glm:alpha"]);
  assert.deepEqual(collisions.find((c) => c.project === "beta").sessions, ["kimi:beta"]);
});

await test("two repos on one project+file: two episodes by repo#pr, sessions project-scoped", () => {
  const withEvidence = claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7()] });
  const otherRepo = claim("kimi:trantor", "trantor", "src/x.ts", {
    gitRoot: "/wt/kimi",
    remote: [{ repo: "acme/other", number: 7, author: "alice", url: "", files: ["src/x.ts"] }],
  });
  const mixed = detectCollisions({ now: NOW, claims: [withEvidence, otherRepo] })
    .filter((c) => c.kind === "remote-overlap");
  assert.equal(mixed.length, 2, "each claimant sees only its OWN repo's PR");
  const glmEpisode = mixed.find((c) => c.repo === "acme/widgets");
  const kimiEpisode = mixed.find((c) => c.repo === "acme/other");
  assert.notEqual(collisionIdentity(glmEpisode), collisionIdentity(kimiEpisode), "repo#pr separates the episodes");
  assert.deepEqual(glmEpisode.sessions, ["glm:trantor", "kimi:trantor"], "same project+file: both sessions, per project scope");
  assert.deepEqual(kimiEpisode.sessions, ["glm:trantor", "kimi:trantor"]);
});

await test("closed PR ends the episode; stale claims and non-claimed files stay silent", () => {
  const open = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7()] })],
  }).filter((c) => c.kind === "remote-overlap");
  assert.equal(open.length, 1);
  // the PR closed: the next client poll drops it, so the refreshed claim carries no remote
  const closed = detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [] })],
  }).filter((c) => c.kind === "remote-overlap");
  assert.deepEqual(closed, [], "no PR evidence, no collision — the episode ends");
  assert.deepEqual(detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7()], ts: NOW - 10 * 60 * 1000 - 1 })],
  }).filter((c) => c.kind === "remote-overlap"), [], "a stale claim is nobody editing");
  assert.deepEqual(detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [remote7(["src/other.ts"])] })],
  }).filter((c) => c.kind === "remote-overlap"), [], "evidence for another file never attaches here");
  assert.deepEqual(detectCollisions({
    now: NOW,
    claims: [claim("glm:trantor", "trantor", "src/x.ts", { gitRoot: "/wt/glm", remote: [null, {}, { repo: "no-slash", number: 7, files: ["src/x.ts"] }, { repo: "acme/widgets", number: "x", files: ["src/x.ts"] }] })],
  }).filter((c) => c.kind === "remote-overlap"), [], "junk evidence is dropped");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
