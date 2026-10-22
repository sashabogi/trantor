#!/usr/bin/env node
// #12140: crew commands from the phone and the crew roster on an enforce hub —
// role gate (write 403, approver 200), spec validation, claude/--all refusals, claim payload,
// crew ack (done|failed + ANSI-stripped output tail, status never "delivered"), roster
// keyed on the signer's identity name.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

async function sFetch(base, id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body });
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

console.log("# hub crew command + roster (#12140)");

const dir = mkdtempSync(join(tmpdir(), "trantor-12140-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const env = {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000",
};
const hub = await startTestHub({ dir, env });
try {
  const base = hub.base;
  const owner = generate();   // the desktop relay's key
  const phone = generate();   // projA approver, like the real companion (#12113)
  const writer = generate();  // projA write-only
  const own = await sFetch(base, owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("owner enrolled", own.status < 400, `status ${own.status}`);
  const invP = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "approver" }], ttlSec: 60, kind: "human" });
  const regP = await sFetch(base, phone, "POST", "/enroll", { token: invP.json.token || "", name: "phone", kind: "human" });
  ok("phone enrolled as projA approver", regP.status < 400, `status ${regP.status}`);
  const invW = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "write" }], ttlSec: 60, kind: "agent" });
  const regW = await sFetch(base, writer, "POST", "/enroll", { token: invW.json.token || "", name: "writerA", kind: "agent" });
  ok("projA writer enrolled", regW.status < 400, `status ${regW.status}`);

  // ---- role gate --------------------------------------------------------------
  let r = await sFetch(base, writer, "POST", "/crew/command", { project: "projA", action: "up", seats: ["glm"] });
  ok("write-only key cannot queue a crew command", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["glm"], _op: "op-up-glm" });
  ok("approver queues up glm", r.status === 200 && r.json.status === "queued" && r.json.id > 0, JSON.stringify(r.json));
  const upId = r.json.id;
  const dup = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["glm"], _op: "op-up-glm" });
  ok("_op replay returns the same id", dup.json.id === upId, JSON.stringify(dup.json));
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projB", action: "up", seats: ["glm"] });
  ok("projA approver cannot drive projB's crew", r.status === 403, `status ${r.status}`);

  // ---- validation and refusals -------------------------------------------------
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "bounce", seats: ["glm"] });
  ok("unknown action is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["BAD SPEC!!"] });
  ok("invalid spec is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["a", "b", "c", "d", "e", "f", "g"] });
  ok("more than 6 seats is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["claude"] });
  ok("the claude seat is refused with the quota reason",
    r.status === 400 && String(r.json.error || "").includes("Claude quota"), JSON.stringify(r.json));
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["claude:projA"] });
  ok("claude with a project suffix is refused too", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["claude-2"] });
  ok("a numbered claude seat is refused too", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "down", seats: ["--all"] });
  ok("--all as a seat is refused", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "swap", from: "glm", to: "--all" });
  ok("--all as a swap target is refused", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: [] });
  ok("up with no seats is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "swap", from: "glm" });
  ok("swap without to is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { action: "up", seats: ["glm"] });
  ok("missing project is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "up", seats: ["kimi-10:trantor", "codex-8"] });
  ok("agent:project specs and multiple seats queue", r.status === 200, JSON.stringify(r.json));

  // ---- claim carries the crew payload ------------------------------------------
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: upId, host: "mac" });
  ok("claim carries kind crew with action and seats",
    r.status === 200 && r.json.prompt?.kind === "crew" && r.json.prompt.action === "up"
    && JSON.stringify(r.json.prompt.seats) === '["glm"]' && r.json.prompt.text === "up glm", JSON.stringify(r.json.prompt));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${upId}`);
  ok("while claimed the phone reads status claimed", r.json.status === "claimed", JSON.stringify(r.json));

  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "swap", from: "glm", to: "kimi", _op: "op-swap" });
  const swapId = r.json.id;
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: swapId, host: "mac" });
  ok("swap claim carries from and to with the summary text",
    r.json.prompt?.from === "glm" && r.json.prompt.to === "kimi" && r.json.prompt.text === "swap glm kimi", JSON.stringify(r.json.prompt));

  r = await sFetch(base, phone, "POST", "/crew/command", { project: "projA", action: "down", seats: [], _op: "op-down-all" });
  const downId = r.json.id;
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: downId, host: "mac" });
  ok("down with an empty list means the whole project",
    r.json.prompt?.action === "down" && JSON.stringify(r.json.prompt.seats) === "[]" && r.json.prompt.text === "down projA", JSON.stringify(r.json.prompt));

  // ---- crew ack: done|failed with the output tail -------------------------------
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: upId, outcome: "delivered" });
  ok("crew ack rejects the delivered outcome", r.status === 400, `status ${r.status}`);
  const noisy = "\x1b[32m✓\x1b[0m crew up: glm (window 3)\n" + "x".repeat(3000);
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: upId, outcome: "done", output: noisy });
  ok("crew ack done lands with status done", r.status === 200 && r.json.status === "done", JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${upId}`);
  ok("phone reads done with the ANSI-stripped 2000-char tail",
    r.json.status === "done" && r.json.outcome === "done" && r.json.output?.length === 2000
    && !r.json.output.includes("\x1b") && r.json.output.endsWith("xxx"),
    JSON.stringify({ status: r.json.status, len: r.json.output?.length }));
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: upId, outcome: "done" });
  ok("re-acking a terminal crew prompt is 409", r.status === 409, `status ${r.status}`);

  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: downId, outcome: "failed", output: "spawn failed: no window", error: "exit 1" });
  ok("crew ack failed lands with the error kept", r.status === 200 && r.json.status === "failed", JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${downId}`);
  ok("phone reads failed with output and error",
    r.json.status === "failed" && r.json.outcome === "failed" && r.json.output === "spawn failed: no window" && r.json.error === "exit 1", JSON.stringify(r.json));

  // ---- audit ---------------------------------------------------------------------
  r = await sFetch(base, owner, "GET", "/events?project=projA&type=chat.prompt.queued&limit=2000");
  const crewEv = (r.json.events || []).find(e => e.promptId === upId);
  ok("queueing is audited with kind and action", crewEv?.kind === "crew" && crewEv.action === "up" && crewEv.text === "up glm", JSON.stringify(crewEv));

  // ---- roster ---------------------------------------------------------------------
  r = await sFetch(base, phone, "POST", "/crew/roster", { machine: "mac", seats: [] });
  ok("a non-owner cannot publish a roster", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, owner, "POST", "/crew/roster", {
    machine: "spoofed",
    seats: [
      { agent: "glm", label: "GLM 4.6", plan: "sub", metered: false, available: true },
      { agent: "kimi", label: "Kimi K2", plan: "api", metered: true, available: false, reason: "balance low" },
    ],
  });
  ok("owner publishes the roster under the signer's name, not the body machine",
    r.status === 200 && r.json.machine === "owner" && r.json.seats === 2, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", "/crew/roster");
  const machines = r.json.machines || [];
  const row = machines.find(m => m.machine === "owner");
  ok("GET returns the machines envelope keyed on the signer",
    r.status === 200 && machines.length === 1 && row && !machines.some(m => m.machine === "spoofed"), JSON.stringify(machines.map(m => m.machine)));
  ok("the roster row carries updatedAt and seats with reason",
    row?.updatedAt > 0 && row.seats?.length === 2
    && row.seats[0].agent === "glm" && row.seats[0].available === true
    && row.seats[1].reason === "balance low" && row.seats[1].metered === true, JSON.stringify(row));
} finally {
  await hub.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
