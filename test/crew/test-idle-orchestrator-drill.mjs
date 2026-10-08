// #11109: replay an idle orchestrator alongside a stale same-directory pane through the socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyRecipientResolver, recipientVerdict } from "../../lib/duty-recipient.mjs";
import { claimDutyNudges, readDutyNudgeState } from "../../lib/duty-nudges.mjs";
import { resolveRecipient, wakeOnce } from "../../bin/wake-nudge.mjs";
import { ledgerPaths } from "../../hooks/lib/inbox-ledger.mjs";

const recipient = "local:trantor";
const sid = "mapped-orchestrator";
const stale = { agent: "claude", cwd: "/work/trantor", pane_id: "stale", agent_status: "done" };
const live = { ...stale, pane_id: "live", agent_session: { value: sid } };
const verdict = (agents, mapped = sid) => recipientVerdict(recipient, { localHost: "local", mapped, agents });

test("the session map wins over directory matches without guessing between exact matches", () => {
  assert.equal(verdict([stale, live]), "idle");
  assert.equal(verdict([live, stale]), "idle");
  assert.equal(verdict([stale, { ...live, agent_status: "working" }]), "busy");
  assert.equal(verdict([{ ...stale, agent_status: "working" }, live]), "idle");
  assert.equal(verdict([live], ""), "idle");
  assert.notEqual(verdict([live, { ...live, pane_id: "duplicate" }]), "idle");
});

test("mapped local discovery gaps do not become terminal handled deliveries", async () => {
  mkdirSync(".agent-bus-out", { recursive: true });
  const bus = mkdtempSync(".agent-bus-out/idle-gap-");
  try {
    const resolve = dutyRecipientResolver({ localHost: "local", bus,
      readText: () => `trantor\t${sid}\n`, listAgents: async () => ({ result: { agents: [] } }) });
    const plan = await claimDutyNudges({ statePath: join(bus, "ledger.json"), owner: "duty:drill",
      resolveRecipient: resolve, messages: [{ from: "hub:duty", text: `UNDELIVERED: #26129 glm:trantor -> ${recipient}` }] });
    assert.equal(plan.items.length, 1, "duty must still try its session discovery");
    assert.equal(readDutyNudgeState(join(bus, "ledger.json")).nudged[26129], undefined);
  } finally { rmSync(bus, { recursive: true, force: true }); }
});

test("idle mapped orchestrator receives its delivery with a stale pane present", async () => {
  mkdirSync(".agent-bus-out", { recursive: true });
  const bus = mkdtempSync(".agent-bus-out/idle-wake-");
  const socketPath = join(bus, "101.sock");
  const pollStamp = ledgerPaths(recipient, sid, bus).pollStamp;
  writeFileSync(join(bus, "orch-sessions.txt"), `trantor\t${sid}\n`);
  const received = [];
  const server = createServer(socket => {
    let text = "";
    socket.on("data", chunk => { text += chunk; });
    socket.on("end", () => {
      received.push(text.trim().split("\n").map(line => JSON.parse(line)));
      writeFileSync(pollStamp, String(Date.now()));
      socket.end();
    });
  });
  const command = (cmd, args) => {
    if (cmd === "herdr") return JSON.stringify({ result: { agents: [stale, live] } });
    if (cmd === "ps" && args[0] === "-axo") return `101 1 claude --resume ${sid}\n102 101 node mcp.mjs`;
    if (cmd === "ps" && args[2] === "102") return `CLAUDE_CODE_MESSAGING_SOCKET=${socketPath} CLAUDE_CODE_MESSAGING_TOKEN=drill-token`;
    return "";
  };
  try {
    server.listen(socketPath);
    await once(server, "listening");
    const resolver = () => resolveRecipient(recipient, { bus, localHost: "local", socketDir: bus, command });
    const text = `UNDELIVERED: #26129 glm:trantor -> ${recipient} — delivery body must stay on the bus`;
    const preflight = dutyRecipientResolver({ bus, localHost: "local",
      listAgents: async () => ({ result: { agents: [stale, live] } }) });
    const plan = await claimDutyNudges({ statePath: join(bus, "duty-nudged.json"),
      messages: [{ from: "hub:duty", text }], owner: "duty:drill", resolveRecipient: preflight });
    assert.equal(plan.items.length, 1, "runner must require the nudge");
    const started = Date.now();
    const result = await wakeOnce({ bus, resolver, verifyMs: 1500,
      api: async path => path.startsWith("/events")
        ? { events: [{ id: 71417, by: "hub:duty", text, ts: started }] }
        : { deliveredUpTo: 0 } });
    assert.equal(result.nudged.length, 1);
    assert.ok(Date.now() - started < 2000);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0][0], { type: "auth", token: "drill-token" });
    assert.equal(received[0][1].session_id, sid);
    assert.match(received[0][1].message.content, /#26129/);
    assert.doesNotMatch(received[0][1].message.content, /delivery body/);
    assert.ok(Number(readFileSync(pollStamp, "utf8")) >= started);
    assert.equal(readDutyNudgeState(join(bus, "duty-nudged.json")).nudged[26129].source, "wake");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(bus, { recursive: true, force: true });
  }
});
