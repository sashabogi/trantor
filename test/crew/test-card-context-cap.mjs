#!/usr/bin/env node
// #11855 card context cap: the three harness readers against trees laid out like the real ones,
// and the pure decision (under cap, over cap, min steps, max handoffs, disabled). No live CLI.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexStepInput, kimiStepInput, claudeStepInput, processedInput } from "../../lib/turn-usage.mjs";
import { capConfig, capDecision } from "../../lib/context-cap.mjs";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  PASS  ${name}`); };
const FX = join(import.meta.dirname, "..", "fixtures", "context-cap");
const fx = (n) => readFileSync(join(FX, n), "utf8");
const tmp = (p) => mkdtempSync(join(tmpdir(), `cap-${p}-`));
const since = Date.parse("2026-10-13T14:59:00.000Z");
const now = Date.parse("2026-10-13T16:00:00.000Z");
const touch = (f, ms) => utimesSync(f, ms / 1000, ms / 1000);
const pad = (n) => String(n).padStart(2, "0");
console.log("# card context cap");

function codexTree(files) {
  const root = tmp("codex"), d = new Date(now);
  const dir = join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dir, { recursive: true });
  for (const [name, cwd, mt] of files) {
    const f = join(dir, name);
    writeFileSync(f, fx("codex-rollout.jsonl").replace("__CWD__", cwd));
    touch(f, mt);
  }
  return root;
}

console.log("\nreaders:");
ok("codex: input includes the cache, split once -> processed 130000", () => {
  const root = codexTree([["rollout-2026-10-13T11-00-00-aaa.jsonl", "/w/seat-a", now - 1000]]);
  const u = codexStepInput(root, since, "/w/seat-a", { nowMs: now });
  assert.deepEqual(u, { input: 10000, output: 40, cacheRead: 120000, cacheWrite: 0 });
  assert.equal(processedInput(u), 130000);
});
ok("codex: another seat's newer rollout (different cwd) is ignored", () => {
  const root = codexTree([
    ["rollout-2026-10-13T11-00-00-aaa.jsonl", "/w/seat-a", now - 5000],
    ["rollout-2026-10-13T11-00-01-bbb.jsonl", "/w/seat-b", now - 1000],
  ]);
  assert.equal(processedInput(codexStepInput(root, since, "/w/seat-a", { nowMs: now })), 130000);
  assert.equal(codexStepInput(root, since, "/w/seat-c", { nowMs: now }), null);
});
ok("codex: a rollout older than the turn window is not read; missing tree is null", () => {
  const root = codexTree([["rollout-2026-10-13T11-00-00-aaa.jsonl", "/w/seat-a", since - 60000]]);
  assert.equal(codexStepInput(root, since, "/w/seat-a", { nowMs: now }), null);
  assert.equal(codexStepInput(join(root, "nope"), since, "/w/seat-a", { nowMs: now }), null);
});
ok("codex: a resumed session in an earlier day dir is still found", () => {
  const root = tmp("codex-old"), d = new Date(now - 3 * 86400000);
  const dir = join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "rollout-old.jsonl");
  writeFileSync(f, fx("codex-rollout.jsonl").replace("__CWD__", "/w/seat-a"));
  touch(f, now - 1000);
  assert.equal(processedInput(codexStepInput(root, since, "/w/seat-a", { nowMs: now })), 130000);
});
ok("kimi: wire found by sid, last usage.record -> 141500 (other + cacheRead + cacheCreation)", () => {
  const root = tmp("kimi");
  for (const sid of ["session_mine", "session_other"]) {
    const dir = join(root, "wd_x_1", sid, "agents", "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wire.jsonl"), sid === "session_mine" ? fx("kimi-wire.jsonl") : fx("kimi-wire.jsonl").replaceAll("140000", "9"));
  }
  assert.equal(processedInput(kimiStepInput(root, "session_mine", 1791903600000)), 141500);
  assert.equal(processedInput(kimiStepInput(root, "session_other", 1791903600000)), 1509);
  assert.equal(kimiStepInput(root, "", 1791903600000), null);
  assert.equal(kimiStepInput(root, "session_gone", 1791903600000), null);
});
ok("claude: last non-sidechain assistant usage -> 125503", () => {
  const dir = tmp("claude");
  writeFileSync(join(dir, "c-1.jsonl"), fx("claude-transcript.jsonl"));
  assert.equal(processedInput(claudeStepInput(dir, since)), 125503);
  assert.equal(claudeStepInput(join(dir, "none"), since), null);
  assert.equal(claudeStepInput(dir, now + 1e9), null);
});

console.log("\ndecision:");
const base = { ...capConfig({}), turn: 10, freshTurn: 0, handoffs: 0, logged: false };
ok("defaults are 120000 / 5 / 3", () => assert.deepEqual(capConfig({}), { cap: 120000, minSteps: 5, maxHandoffs: 3 }));
ok("env overrides parse; 0 disables", () => {
  assert.equal(capConfig({ TRANTOR_CARD_CONTEXT_CAP: "60000" }).cap, 60000);
  assert.equal(capConfig({ TRANTOR_CARD_CONTEXT_CAP: "0" }).cap, 0);
});
ok("under the cap -> none", () => assert.equal(capDecision({ ...base, step: 119999 }), "none"));
ok("unreadable step (null) -> none", () => assert.equal(capDecision({ ...base, step: null }), "none"));
ok("over the cap -> handoff", () => assert.equal(capDecision({ ...base, step: 130000 }), "handoff"));
ok("min-steps guard: a fresh session needs 5 turns before it can trip again", () => {
  assert.equal(capDecision({ ...base, step: 130000, turn: 13, freshTurn: 10 }), "none");
  assert.equal(capDecision({ ...base, step: 130000, turn: 14, freshTurn: 10 }), "none");
  assert.equal(capDecision({ ...base, step: 130000, turn: 15, freshTurn: 10 }), "handoff");
});
ok("max-handoffs guard: logs once, then stays quiet", () => {
  assert.equal(capDecision({ ...base, step: 130000, handoffs: 3 }), "log-exhausted");
  assert.equal(capDecision({ ...base, step: 130000, handoffs: 3, logged: true }), "exhausted");
  assert.equal(capDecision({ ...base, step: 100, handoffs: 3 }), "none");
});
ok("cap=0 disables everything", () => {
  assert.equal(capDecision({ ...base, cap: 0, step: 9e9 }), "none");
  assert.equal(capDecision({ ...base, cap: 0, step: 9e9, handoffs: 3 }), "none");
});

console.log(`\n${pass} passed`);
