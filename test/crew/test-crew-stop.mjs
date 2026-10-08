import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { down } from "../../bin/crew/state.mjs";
import { seatWhy } from "../../lib/seat-why.mjs";

const out = resolve(".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "crew-stop-"));
const statePath = join(dir, "crew-windows.txt");
const ctx = { project: "fixture", statePath, env: { CREW_NO_PROC_KILL: "1" }, dry: false };
const closed = [], lines = [];
const adapters = { herdr: { closePane: pane => closed.push(pane), closeWorkspace: pane => closed.push(pane) } };
const log = console.log;
const diagnose = (agent = "glm", pids = []) => seatWhy("fixture", agent, { dir, pidCheck: () => pids });
const seed = () => writeFileSync(statePath, "fixture\therdr\tglm\tp1\nfixture\therdr\tcodex\tp2\nfixture\therdr\tkimi\tp3\nother\therdr\tglm\tp4\n");
try {
  console.log = line => lines.push(line);
  seed();
  writeFileSync(join(dir, "err-glm-fixture.txt"), "429 quota exhausted\n");
  assert.equal(diagnose().state, "dead-quota");
  await down(ctx, ["glm"], adapters);
  assert.match(lines.at(-1), /glm stopped \(codex, kimi still running\)/);
  assert.ok(!lines.at(-1).includes("crew torn down"));
  assert.deepEqual(closed, ["p1"]);
  assert.ok(readFileSync(statePath, "utf8").includes("other\therdr\tglm\tp4"));
  assert.equal(diagnose().state, "stopped");
  assert.match(diagnose().advice, /trantor up/);
  log("ok 1 - single seat output, siblings and other project survive, stale quota becomes stopped");

  assert.equal(diagnose("glm", [1234]).state, "no-pane");
  log("ok 2 - live process evidence wins over prior stop");
  appendFileSync(join(dir, "logs/glm-fixture.jsonl"), `${JSON.stringify({ts: Date.now(), boot: true})}\n`);
  assert.equal(diagnose().state, "dead-quota");
  log("ok 3 - a later boot supersedes the operator stop");

  lines.length = 0;
  await down(ctx, [], adapters);
  assert.match(lines.at(-1), /crew torn down \(project "fixture"\)/);
  assert.equal(diagnose("codex").state, "stopped");
  assert.equal(diagnose("kimi").state, "stopped");
  assert.equal(readFileSync(statePath, "utf8"), "other\therdr\tglm\tp4\n");
  log("ok 4 - whole-project shutdown keeps its message and marks each seat stopped");

  seed();
  const before = readFileSync(join(dir, "logs/glm-fixture.jsonl"), "utf8");
  await down({...ctx, dry: true}, ["glm"], adapters);
  assert.equal(readFileSync(join(dir, "logs/glm-fixture.jsonl"), "utf8"), before);
  assert.ok(readFileSync(statePath, "utf8").includes("fixture\therdr\tglm\tp1"));
  log("ok 5 - dry run leaves state and stop evidence unchanged");
} finally {
  console.log = log;
  rmSync(dir, { recursive: true, force: true });
}
console.log("5 passed");
