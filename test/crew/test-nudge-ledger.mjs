#!/usr/bin/env node
// #11355 drill: both orchestrator-wake nudgers (com.trantor.wake-nudge daemon and the duty seat's
// runner-side nudge plan) offered the SAME unread id produce EXACTLY ONE send — the loser logs
// "already nudged #N" and stands down. Plus ledger mechanics: concurrency, TTL, per-recipient
// files, claim release. Never runs the full suite: this file is the card's own gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as netServer } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { wakeOnce } from "../../bin/wake-nudge.mjs";
import { claimDutyNudges, dutyNudgeDirective, readDutyNudgeState, releaseDutyNudgeClaims } from "../../lib/duty-nudges.mjs";
import { reserveNudgeIds, releaseNudgeIds, nudgeLedgerPath, NUDGE_LEDGER_TTL_MS } from "../../lib/nudge-ledger.mjs";
import { ledgerPaths } from "../../hooks/lib/inbox-ledger.mjs";

const root = resolve(".");
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "nl-"));
const sockets = mkdtempSync(join(tmpdir(), "nl-"));
const recipient = "local:trantor";
const sid = "nudge-drill-session";
// the alert rides BOTH shapes: `by` is the /events feed field wakeOnce filters on, `from` is the
// inbox-message field the duty escalation parser reads.
const alert = (id = 51, to = recipient) => ({ id: id + 1000, by: "hub:duty", from: "hub:duty", type: "message", ts: Date.now(), text: `UNDELIVERED for 2m: #${id} sender:trantor -> ${to} — "untrusted content"` });

function socketFixture(bus, name) {
  const socketPath = join(sockets, `${name}.sock`);
  const pollStamp = ledgerPaths(recipient, sid, bus).pollStamp;
  let count = 0;
  const server = netServer(socket => {
    let data = "";
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => { count++; writeFileSync(pollStamp, String(Date.now())); socket.end(); });
  });
  return { socketPath, pollStamp, sent: () => count, listen: async () => { server.listen(socketPath); await once(server, "listening"); }, close: () => server.close() };
}

test("THE DRILL: duty stamps first, the wake daemon logs already-nudged and sends nothing", async () => {
  const bus = join(dir, "duty-first"); mkdirSync(bus);
  const logs = [];
  const first = await reserveNudgeIds({
    recipient, ids: ["51"], owner: "duty-turn-1", bus,
    log: m => logs.push(m),
  });
  assert.deepEqual(first.allowed, ["51"]);
  assert.deepEqual(first.skipped, []);
  const fx = socketFixture(bus, "duty-first");
  await fx.listen();
  try {
    const event = alert();
    const api = async path => path.startsWith("/events") ? { events: [event] } : { deliveredUpTo: 0 };
    const options = { bus, api, resolver: () => ({ sid, socketPath: fx.socketPath, token: "secret", pollStamp: fx.pollStamp }), verifyMs: 200, log: m => logs.push(m) };
    const result = await wakeOnce(options);
    assert.equal(fx.sent(), 0, "the wake daemon must not send an id the duty path already stamped");
    assert.equal(result.nudged.length, 0);
    assert.equal(result.missing.length, 0, "a skipped id is the other path's job, never reported missing");
    assert.ok(logs.includes("already nudged #51"), `log line missing, got: ${JSON.stringify(logs)}`);
    // and the released duty-nudged claim does not stay under the wake's owner
    const state = readDutyNudgeState(join(bus, "duty-nudged.json"));
    assert.equal(state.planned["51"], undefined, "skipped ids release their planned claim");
  } finally { fx.close(); }
});

test("THE DRILL, other way: the wake daemon wins, the duty path is skipped", async () => {
  const bus = join(dir, "wake-first"); mkdirSync(bus);
  const fx = socketFixture(bus, "wake-first");
  await fx.listen();
  try {
    const event = alert(52);
    const api = async path => path.startsWith("/events") ? { events: [event] } : { deliveredUpTo: 0 };
    const options = { bus, api, resolver: () => ({ sid, socketPath: fx.socketPath, token: "secret", pollStamp: fx.pollStamp }), verifyMs: 200, log: () => {} };
    const result = await wakeOnce(options);
    assert.equal(result.nudged.length, 1);
    assert.equal(fx.sent(), 1, "exactly one send");
    const logs = [];
    const duty = await reserveNudgeIds({ recipient, ids: ["52"], owner: "duty-turn-1", bus, log: m => logs.push(m) });
    assert.deepEqual(duty.allowed, []);
    assert.deepEqual(duty.skipped.map(s => s.id), ["52"]);
    assert.ok(logs.includes("already nudged #52"));
    // the runner-side shape: a claimed id lost to the ledger leaves no mandatory directive
    const plan = await claimDutyNudges({ messages: [{ from: "hub:duty", text: event.text }], statePath: join(bus, "duty-nudged.json"), owner: "duty-turn-1" });
    assert.equal(dutyNudgeDirective(plan).includes("MECHANICAL DUTY NUDGE REQUIREMENT"), false, "no directive for a ledger-held id");
  } finally { fx.close(); }
});

test("concurrent reservations of one id elect exactly one winner (locked check-and-stamp)", async () => {
  const bus = join(dir, "race"); mkdirSync(bus);
  const [a, b, c] = await Promise.all([
    reserveNudgeIds({ recipient, ids: ["77"], owner: "a", bus, log: () => {} }),
    reserveNudgeIds({ recipient, ids: ["77"], owner: "b", bus, log: () => {} }),
    reserveNudgeIds({ recipient, ids: ["77"], owner: "c", bus, log: () => {} }),
  ]);
  const winners = [a, b, c].filter(r => r.allowed.length === 1);
  assert.equal(winners.length, 1, "exactly one of three concurrent nudgers wins");
  assert.equal(winners[0].allowed[0], "77");
  const ledger = JSON.parse(readFileSync(nudgeLedgerPath(recipient, { bus }), "utf8"));
  assert.equal(ledger.nudged["77"].at > 0, true);
  assert.ok(!readdirSync(bus).some(f => f.includes(".tmp")), "atomic writes leave no tmp files");
});

test("an id suppressed under the TTL is nudgeable again once it expires, and stale entries are pruned", async () => {
  const bus = join(dir, "ttl"); mkdirSync(bus);
  const path = nudgeLedgerPath(recipient, { bus });
  const now = 1_000_000;
  const first = await reserveNudgeIds({ recipient, ids: ["9"], owner: "a", now, bus, log: () => {} });
  assert.deepEqual(first.allowed, ["9"]);
  const inside = await reserveNudgeIds({ recipient, ids: ["9"], owner: "b", now: now + NUDGE_LEDGER_TTL_MS - 1, bus, log: () => {} });
  assert.deepEqual(inside.allowed, [], "inside the window the second nudger skips");
  const after = await reserveNudgeIds({ recipient, ids: ["9"], owner: "c", now: now + NUDGE_LEDGER_TTL_MS + 1, bus, log: () => {} });
  assert.deepEqual(after.allowed, ["9"], "past the window the still-unread id is nudgeable again");
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(ledger.nudged["9"].by, "c", "the fresh stamp replaces the pruned one");
});

test("ledgers are per recipient: one session's stamps never suppress another's", async () => {
  const bus = join(dir, "per-recipient"); mkdirSync(bus);
  await reserveNudgeIds({ recipient: "local:alpha", ids: ["5"], owner: "a", bus, log: () => {} });
  const other = await reserveNudgeIds({ recipient: "local:beta", ids: ["5"], owner: "b", bus, log: () => {} });
  assert.deepEqual(other.allowed, ["5"], "beta's id 5 is untouched by alpha's stamp");
  assert.ok(existsSync(nudgeLedgerPath("local:alpha", { bus })));
  assert.ok(existsSync(nudgeLedgerPath("local:beta", { bus })));
  const odd = await reserveNudgeIds({ recipient: "MacBook Pro:M1:x", ids: ["5"], owner: "a", bus, log: () => {} });
  assert.deepEqual(odd.allowed, ["5"]);
  assert.ok(existsSync(nudgeLedgerPath("MacBook Pro:M1:x", { bus })), "odd session ids sanitize into safe file names");
});

test("releaseDutyNudgeClaims drops only this owner's planned claims", async () => {
  const bus = join(dir, "release"); mkdirSync(bus);
  const statePath = join(bus, "duty-nudged.json");
  const plan = await claimDutyNudges({ messages: [alert(81), alert(82)], statePath, owner: "duty-turn-9" });
  assert.equal(plan.items.length, 2);
  await releaseDutyNudgeClaims({ ids: ["81"], statePath, owner: "duty-turn-9" });
  const state = readDutyNudgeState(statePath);
  assert.equal(state.planned["81"], undefined, "own claim released");
  assert.equal(state.planned["82"]?.owner, "duty-turn-9", "sibling claim untouched");
  await releaseDutyNudgeClaims({ ids: ["82"], statePath, owner: "somebody-else" });
  assert.equal(readDutyNudgeState(statePath).planned["82"]?.owner, "duty-turn-9", "another owner's claim is never stolen");
});

test("a partially held batch sends only the allowed ids and reports none of them missing", async () => {
  const bus = join(dir, "partial"); mkdirSync(bus);
  await reserveNudgeIds({ recipient, ids: ["91"], owner: "duty-turn-1", bus, log: () => {} });
  const fx = socketFixture(bus, "partial");
  await fx.listen();
  try {
    const events = [alert(91), alert(92)];
    const api = async path => path.startsWith("/events") ? { events } : { deliveredUpTo: 0 };
    const options = { bus, api, resolver: () => ({ sid, socketPath: fx.socketPath, token: "secret", pollStamp: fx.pollStamp }), verifyMs: 200, log: () => {} };
    const result = await wakeOnce(options);
    assert.equal(fx.sent(), 1, "one socket post for the pair of ids");
    assert.equal(result.nudged.length, 1, "only the allowed id verifies");
    assert.equal(result.missing.length, 0, "the skipped id is not reported missing");
  } finally { fx.close(); }
});

test("an UNVERIFIED send releases its stamp so the other nudger may still try", async () => {
  const bus = join(dir, "unverified"); mkdirSync(bus);
  // a socket that accepts the post but never advances the poll stamp: the nudge never verifies
  const socketPath = join(sockets, "unverified.sock");
  const pollStamp = join(bus, "no-poll");
  let posts = 0;
  const server = netServer(socket => { posts++; socket.resume(); socket.on("end", () => socket.end()); }).listen(socketPath);
  await once(server, "listening");
  try {
    const api = async path => path.startsWith("/events") ? { events: [alert(61)] } : { deliveredUpTo: 0 };
    const options = { bus, api, resolver: () => ({ sid, socketPath, token: "secret", pollStamp }), verifyMs: 100, log: () => {} };
    const result = await wakeOnce(options);
    assert.equal(posts, 1);
    assert.equal(result.missing.length, 1, "the unverified nudge stays reported as owed");
    const retry = await reserveNudgeIds({ recipient, ids: ["61"], owner: "duty-turn-1", bus, log: () => {} });
    assert.deepEqual(retry.allowed, ["61"], "the stamp was released — the duty path may nudge");
    assert.deepEqual(retry.skipped, []);
  } finally { server.close(); }
});

test("a VERIFIED send keeps its stamp: the other nudger still skips", async () => {
  const bus = join(dir, "verified"); mkdirSync(bus);
  const fx = socketFixture(bus, "verified");
  await fx.listen();
  try {
    const api = async path => path.startsWith("/events") ? { events: [alert(62)] } : { deliveredUpTo: 0 };
    const options = { bus, api, resolver: () => ({ sid, socketPath: fx.socketPath, token: "secret", pollStamp: fx.pollStamp }), verifyMs: 200, log: () => {} };
    const result = await wakeOnce(options);
    assert.equal(result.nudged.length, 1);
    const second = await reserveNudgeIds({ recipient, ids: ["62"], owner: "duty-turn-1", bus, log: () => {} });
    assert.deepEqual(second.allowed, [], "a verified send suppresses the other path for the TTL");
  } finally { fx.close(); }
});

test("releaseNudgeIds drops only the caller's own stamps inside the window", async () => {
  const bus = join(dir, "release-stamps"); mkdirSync(bus);
  const path = nudgeLedgerPath(recipient, { bus });
  await reserveNudgeIds({ recipient, ids: ["71", "72"], owner: "wake:1", now: 1000, bus, log: () => {} });
  await releaseNudgeIds({ recipient, ids: ["71"], owner: "duty-turn-1", now: 1001, bus });
  assert.ok(JSON.parse(readFileSync(path, "utf8")).nudged["71"], "another path's stamp is never stolen");
  await releaseNudgeIds({ recipient, ids: ["71"], owner: "wake:1", now: 1001, bus });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).nudged["71"], undefined, "own stamp released");
  await releaseNudgeIds({ recipient, ids: ["72"], owner: "wake:1", now: 1000 + NUDGE_LEDGER_TTL_MS + 1, bus });
  assert.ok(JSON.parse(readFileSync(path, "utf8")).nudged["72"], "an expired stamp is left for the reserve-time prune");
});

test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
