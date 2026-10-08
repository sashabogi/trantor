import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { allocatePersona, runnerPersona } from "../../lib/persona.mjs";
import { loadOrCreate } from "../../lib/identity.mjs";

const root = resolve(".agent-bus-out");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "persona-"));
const previous = process.env.AGENT_BUS_DIR;
process.env.AGENT_BUS_DIR = dir;
try {
  const options = { dir, project: "persona-drill", agent: "glm", model: "zai/test" };
  const first = allocatePersona(options);
  const second = allocatePersona(options);
  assert.equal(first.persona, "glm");
  assert.equal(second.persona, "glm-2");
  const legacy = loadOrCreate("glm:persona-drill");
  assert.equal(loadOrCreate(`${runnerPersona({}, "glm")}:persona-drill`).pubkey, legacy.pubkey);
  assert.notEqual(loadOrCreate(`${second.persona}:persona-drill`).pubkey, legacy.pubkey);
  const named = allocatePersona({ ...options, name: "reviewer" });
  assert.equal(named.persona, "reviewer");
  assert.equal(runnerPersona({ CREW_PERSONA: "reviewer" }, "kimi"), "reviewer");
  assert.throws(() => allocatePersona({ ...options, name: "reviewer", occupied: ["reviewer"] }), /already active/);
  assert.throws(() => allocatePersona({ ...options, name: "../escape" }), /persona must/);
  console.log("persona allocation and legacy key migration: 8 checks passed");
} finally {
  if (previous === undefined) delete process.env.AGENT_BUS_DIR;
  else process.env.AGENT_BUS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
}
