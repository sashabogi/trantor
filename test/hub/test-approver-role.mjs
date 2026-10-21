#!/usr/bin/env node
// #12113: a phone can decide within its scopes without acquiring owner-only powers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";
import { drillEnv } from "../drill-env.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";

const root = resolve(import.meta.dirname, "../..");
mkdirSync(join(root, ".agent-bus-out"), { recursive: true });
const dir = mkdtempSync(join(root, ".agent-bus-out/approver-role-"));
let passed = 0;
function check(condition, name) { assert.ok(condition, name); console.log(`ok ${++passed} - ${name}`); }
const hub = await startTestHub({ dir, env: {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "invite", RELAY_BOOTSTRAP_TOKEN: "approver-test-bootstrap",
  RELAY_OVERSEER_TICK_MS: "600000",
} });
try {
  const request = async (identity, path, data) => {
    const body = JSON.stringify(data);
    const response = await fetch(hub.base + path, { method: "POST", headers: {
      "content-type": "application/json", ...signRequest(identity, { method: "POST", path, body }),
    }, body });
    return { status: response.status, data: await response.json() };
  };
  const owner = generate();
  check((await request(owner, "/enroll", { name: "admin", kind: "human", token: "approver-test-bootstrap" })).status === 200, "bootstrap owner enrolled");
  const enroll = async (name, project, role, token) => {
    if (!token) {
      const invite = await request(owner, "/invite", { scopes: [{ project, role }] });
      check(invite.status === 200 && invite.data.scopes[0].role === role, `${name} invite preserves role`);
      token = invite.data.token;
    }
    const identity = generate();
    const result = await request(identity, "/enroll", { name, kind: "human", token });
    check(result.status === 200 && result.data.scopes[0].role === role && result.data.scopes[0].project === project, `${name} enrolled with exact scope`);
    return identity;
  };
  const bus = join(dir, ".agent-bus");
  mkdirSync(join(bus, "keys"), { recursive: true });
  writeFileSync(join(bus, "keys/admin.json"), JSON.stringify({ ...owner, name: "admin", kind: "human" }), { mode: 0o600 });
  writeFileSync(join(bus, "config.json"), JSON.stringify({ url: hub.base }));
  const cli = await promisify(execFile)(process.execPath, [join(root, "bin/cli.mjs"), "invite", "--name", "phone", "--scope", "*:approver"], {
    cwd: root, env: drillEnv({ HOME: dir, AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1", TRANTOR_NO_UPDATE_CHECK: "1" }),
  });
  const token = /Invite token: ([a-f0-9]+)/.exec(cli.stdout)?.[1];
  check(Boolean(token), "trantor invite mints approver token");
  const approver = await enroll("phone", "*", "approver", token);
  const writer = await enroll("writer", "*", "write");
  const first = await enroll("first", "*", "write");
  const narrow = await enroll("narrow", "beta", "approver");
  // A mixed scope must not borrow approver authority from a different project.
  const mixedInvite = await request(owner, "/invite", { scopes: [{ project: "alpha", role: "write" }, { project: "beta", role: "approver" }] });
  const mixed = generate();
  check((await request(mixed, "/enroll", { name: "mixed", token: mixedInvite.data.token })).status === 200, "mixed-scope identity enrolled");
  check((await request(owner, "/policy", { autonomy: { alpha: 3 } })).status === 200, "owner sets Gate policy");
  const makeHold = async file => {
    check((await request(first, "/claim", { project: "alpha", session: "first", file })).status === 200, "first file claim accepted");
    const result = await request(writer, "/claim", { project: "alpha", session: "writer", file });
    check(result.status === 200 && result.data.hold?.status === "pending", "conflicting claim creates pending hold");
    return result.data.hold.id;
  };
  const makeProposal = async scope => {
    const result = await request(writer, "/propose", { session: "writer", project: "alpha", scope, condition: "after review", exclusions: "no deletion" });
    check(result.status === 200 && result.data.proposal.status === "pending", "writer files pending proposal");
    return result.data.proposal.id;
  };
  const hold = await makeHold("phone.ts");
  const proposal = await makeProposal("approve phone change");
  for (const [path, id, status] of [["/hold/decide", hold, "go"], ["/proposal/decide", proposal, "approved"]]) {
    for (const [identity, label] of [[writer, "write-only"], [narrow, "other-project approver"], [mixed, "mixed-scope writer"]]) {
      check((await request(identity, path, { id, status, project: "beta" })).status === 403, `${label} denied ${path}`);
    }
    const result = await request(approver, path, { id, status });
    check(result.status === 200 && (result.data.hold || result.data.proposal).status === status, `approver decides ${path}`);
    check((result.data.hold || result.data.proposal).decidedBy === "phone", `${path} records approver identity`);
  }
  for (const path of ["/project/delete", "/invite", "/import", "/policy", "/sweep", "/reconcile"]) {
    check((await request(approver, path, { project: "alpha", scopes: [{ project: "*", role: "owner" }] })).status === 403, `approver denied owner endpoint ${path}`);
  }
  check((await request(owner, "/hold/decide", { id: await makeHold("owner.ts"), status: "nogo" })).status === 200, "owner still decides holds");
  check((await request(owner, "/proposal/decide", { id: await makeProposal("owner change"), status: "denied" })).status === 200, "owner still decides proposals");
} finally {
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed, 0 failed`);
