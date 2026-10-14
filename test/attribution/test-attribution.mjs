import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCommit, attributeHistory, projectAttribution } from "../../lib/attribution.mjs";

const commit = { sha: "a".repeat(40), author: "codex-3", lastAt: "2026-01-01T00:00:00Z", subject: "change #42", body: "Co-Authored-By: Claude <noreply@anthropic.com>", paths: ["a.ts"] };
const evidence = () => ({ receipts: [], cards: new Map(), branches: new Map() });

test("first evidence wins: harvest, card, author, Claude, unknown", () => {
  const data = evidence();
  data.cards.set(42, "kimi-2:trantor");
  data.receipts.push({ main: commit.sha.slice(0, 7), seat: "b".repeat(40), branch: "seat/glm-2", card: 42 });
  assert.deepEqual(resolveCommit(commit, data), { agent: "glm", instance: "glm-2", rule: "harvest" });
  data.receipts = [];
  assert.equal(resolveCommit(commit, data).rule, "card");
  assert.equal(resolveCommit(commit, data).agent, "kimi");
  data.cards.clear();
  assert.deepEqual(resolveCommit(commit, data), { agent: "codex", instance: "codex-3", rule: "author" });
  assert.equal(resolveCommit({ ...commit, author: "sashabogi" }, data).rule, "claude");
  assert.equal(resolveCommit({ ...commit, author: "sashabogi", body: "Claude helped" }, data).agent, "unknown");
});

test("a card assigned to the orchestrator's own session counts as orchestrator, not the host name", () => {
  const data = evidence();
  data.cards.set(42, "MacBook-Pro-M1:trantor");
  assert.deepEqual(resolveCommit({ ...commit, author: "sashabogi" }, data), { agent: "orchestrator", instance: "MacBook-Pro-M1", rule: "card" });
});

test("ambiguous branches fall through to receipt card; conflicting subject cards never guess", () => {
  const data = evidence();
  data.receipts.push({ main: commit.sha, seat: "bbbbbbb", card: 90 });
  data.branches.set("bbbbbbb", ["seat/glm", "seat/kimi"]);
  data.cards.set(90, "openrouter-2:trantor");
  assert.equal(resolveCommit(commit, data).agent, "openrouter");
  data.cards.clear();
  data.branches.set("bbbbbbb", ["seat/glm-2"]);
  assert.equal(resolveCommit(commit, data).agent, "glm");
  data.receipts = [];
  data.cards.set(42, "kimi:trantor"); data.cards.set(43, "glm:trantor");
  assert.equal(resolveCommit({ ...commit, subject: "#42 and #43", author: "Sasha", body: "" }, data).rule, "unknown");
});

test("file shape counts commits, keeps instances and latest timestamp, and reports coverage", () => {
  const result = attributeHistory([
    commit,
    { ...commit, author: "codex-2", lastAt: "2026-02-01T00:00:00Z", paths: ["a.ts", "a.ts", "b.ts"] },
    { ...commit, author: "glm", paths: ["a.ts"] },
  ], evidence());
  assert.deepEqual(result.files[0], { path: "a.ts", agents: [
    { agent: "codex", commits: 2, lastAt: "2026-02-01T00:00:00Z", instances: ["codex-2", "codex-3"] },
    { agent: "glm", commits: 1, lastAt: commit.lastAt, instances: ["glm"] },
  ], dominant: "codex" });
  assert.equal(result.coverage.rules.find(row => row.rule === "author").percent, 100);
  assert.deepEqual(result.agents, [{ agent: "codex", commits: 2 }, { agent: "glm", commits: 1 }]);
});

test("real git handles odd paths, root commit, renames and HEAD cache invalidation", async () => {
  const scratch = join(process.cwd(), ".agent-bus-out");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "attribution-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "codex-2"); git("config", "user.email", "test@example.test");
    const path = "space tab\tline\nname.ts";
    writeFileSync(join(root, path), "one");
    writeFileSync(join(root, "TRANTOR-COMMIT"), "marker is also a legal filename");
    git("add", "--", path, "TRANTOR-COMMIT"); git("commit", "-qm", "first");
    let calls = 0;
    const opts = { root, project: "fixture", receipts: [], loadCards: async () => { calls++; return new Map(); } };
    const first = await projectAttribution(opts);
    assert.ok(first.files.some(row => row.path === path));
    assert.ok(first.files.some(row => row.path === "TRANTOR-COMMIT"));
    assert.equal(first.coverage.total, 1);
    assert.deepEqual(await projectAttribution(opts), first);
    assert.equal(calls, 1);
    git("mv", "--", path, "renamed.ts"); git("commit", "-qm", "rename");
    const next = await projectAttribution(opts);
    assert.notEqual(next.head, first.head);
    assert.equal(calls, 2);
    assert.equal(next.coverage.total, 2);
    assert.ok(next.files.some(row => row.path === "renamed.ts"));
    git("commit", "--allow-empty", "-qm", "empty");
    const empty = await projectAttribution(opts);
    assert.equal(empty.coverage.total, 3);
    assert.equal(empty.files.length, 3);
    git("commit", "--allow-empty", "-qm", "next empty");
    await assert.rejects(projectAttribution({ ...opts, loadCards: async () => { throw new Error("hub offline"); } }), /hub offline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
