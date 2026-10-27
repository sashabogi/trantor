#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionRuntime } from "../../hub/routes/session.mjs";

const scratch = new URL("../../.agent-bus-out/12161-final/", import.meta.url).pathname;
mkdirSync(scratch, { recursive: true });
let checks = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
for (const [path, body] of [
  ["/session/prompt", { text: "photo", attachments: [{ name: "photo.jpg", data: jpeg.toString("base64") }] }],
  ["/session/answer", { session: "s", toolId: "ask", picks: [0] }],
  ["/crew/command", { action: "up", seats: ["codex"] }],
]) {
  const dir = mkdtempSync(join(scratch, "capacity-"));
  try {
    const ts = Date.now();
    const state = { sessionPromptSeq: 200, sessionPrompts: Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, project: "demo", text: "live", ts, claimedAt: ts, host: "mac",
      status: i % 2 ? "queued" : "claimed", attachments: i === 0 ? [{ file: "1-0.jpg", size: jpeg.length }] : [],
    })) };
    writeFileSync(join(dir, "1-0.jpg"), jpeg);
    let dirty = 0;
    const events = [];
    const runtime = createSessionRuntime({ state, attachmentsDir: dir, markDirty() { dirty++; },
      appendEvent: (...args) => events.push(args), pushEventToStreams() {} });
    async function post() {
      let out;
      await runtime.route({ req: { method: "POST" }, res: {}, q: {}, P: path,
        auth: { identity: { name: "phone" } }, ctx: {
          body: async () => ({ project: "demo", ...body }), canon: x => x, scopeAllows: () => true,
          json: (_res, code, value) => { out = { code, value }; return true; },
        } });
      return out;
    }
    const before = JSON.stringify(state);
    equal((await post()).code, 429, `${path}: full live queue refuses new work`);
    equal(JSON.stringify(state), before, `${path}: no live row or sequence changes`);
    equal([dirty, events.length], [0, 0], `${path}: no accepted-work side effects`);
    equal(readdirSync(dir), ["1-0.jpg"], `${path}: no incoming attachment written`);
    equal(readFileSync(join(dir, "1-0.jpg")), jpeg, `${path}: claimed image survives`);
    state.sessionPrompts[199].status = "delivered";
    state.sessionPrompts[199].attachments = [{ file: "terminal.jpg", size: jpeg.length }];
    writeFileSync(join(dir, "terminal.jpg"), jpeg);
    equal((await post()).code, 200, `${path}: terminal row frees capacity`);
    equal(state.sessionPrompts.length, 200, `${path}: queue remains bounded`);
    equal(state.sessionPrompts.some(p => p.id === 200), false, `${path}: only terminal row evicted`);
    equal(state.sessionPrompts[0].id, 1, `${path}: oldest live claim retained`);
    equal(readdirSync(dir).includes("terminal.jpg"), false, `${path}: evicted terminal image removed`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`session capacity: ${checks} checks passed`);
