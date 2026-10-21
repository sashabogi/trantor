#!/usr/bin/env node
// #12129: chat mirror + prompt queue on an enforce hub — delta merge, session-switch reset,
// restart semantics, scope, first-claim-wins, ack outcomes, expiry, stream scope, audit events.
// #12137: /session/answer queues as kind "answer" (ack gains "stale"); unanswered ask blocks
// raise one ask.opened push per toolId, cleared by ask.answered.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";
import { createSessionRuntime } from "../../hub/routes/session.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

async function sFetch(base, id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body });
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function openStream(base, id, session) {
  const path = `/stream?session=${encodeURIComponent(session)}&events=1`;
  const ac = new AbortController();
  const r = await fetch(base + path, { headers: signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method: "GET", path }), signal: ac.signal });
  const s = { status: r.status, buf: "", close: () => ac.abort() };
  if (r.ok) (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of r.body) s.buf += dec.decode(chunk, { stream: true }); } catch {}
  })();
  return s;
}
const turn = (idx, text, role = "assistant") => ({ idx, role, blocks: [{ kind: "text", text }] });

console.log("# hub session chat mirror + prompt queue (#12129)");

const dir = mkdtempSync(join(tmpdir(), "trantor-12129-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const env = {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000",
};
let hub = await startTestHub({ dir, env });
try {
  let base = hub.base;
  const owner = generate();   // the desktop relay's key
  const phone = generate();   // approver role, like the real companion (#12113)
  const reader = generate();  // projA read-only
  const own = await sFetch(base, owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("owner enrolled", own.status < 400, `status ${own.status}`);
  const invP = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "approver" }], ttlSec: 60, kind: "human" });
  const regP = await sFetch(base, phone, "POST", "/enroll", { token: invP.json.token || "", name: "phone", kind: "human" });
  ok("phone enrolled as projA approver", regP.status < 400 && (regP.json.scopes || []).some(s => s.role === "approver"), `status ${regP.status}`);
  const invR = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "read" }], ttlSec: 60, kind: "human" });
  const regR = await sFetch(base, reader, "POST", "/enroll", { token: invR.json.token || "", name: "readerA", kind: "human" });
  ok("projA reader enrolled", regR.status < 400, `status ${regR.status}`);

  // ---- chat mirror: delta merge by idx --------------------------------------
  let r = await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s1", total: 3, turns: [turn(0, "ask", "user"), turn(1, "thinking"), turn(2, "partial answer")] });
  ok("publish answers ok with have=3", r.status === 200 && r.json.have === 3, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", "/session/chat?project=projA&after=0");
  ok("GET after=0 returns turns 1 and 2 only", r.status === 200 && r.json.turns.length === 2 && r.json.turns[0].idx === 1, JSON.stringify(r.json.turns?.map(t => t.idx)));
  // the last turn grew and a new one landed: resend from the lowest changed idx
  r = await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s1", total: 4, turns: [turn(2, "FULL answer"), turn(3, "follow-up", "user")], meta: { working: true, model: "claude", context: 0.4 } });
  ok("delta merge answers have=4", r.status === 200 && r.json.have === 4, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", "/session/chat?project=projA");
  const byIdx = Object.fromEntries((r.json.turns || []).map(t => [t.idx, t.blocks?.[0]?.text]));
  ok("turn 2 replaced by idx, turn 3 appended, older turns intact",
    byIdx[0] === "ask" && byIdx[1] === "thinking" && byIdx[2] === "FULL answer" && byIdx[3] === "follow-up", JSON.stringify(byIdx));
  ok("meta rides the mirror", r.json.meta?.working === true && r.json.meta?.model === "claude", JSON.stringify(r.json.meta));
  // idempotent re-send of the same window changes nothing
  r = await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s1", total: 4, turns: [turn(2, "FULL answer"), turn(3, "follow-up", "user")] });
  ok("re-send is idempotent (have stays 4)", r.json.have === 4, JSON.stringify(r.json));
  // a different session resets the project's mirror
  r = await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s2", total: 1, turns: [turn(0, "fresh session", "user")] });
  ok("session switch resets have to 1", r.json.have === 1, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", "/session/chat?project=projA");
  ok("mirror holds only the new session's turns", r.json.turns.length === 1 && r.json.turns[0].idx === 0 && r.json.session === "s2", JSON.stringify(r.json.turns?.map(t => t.idx)));

  // ---- a prompt that must survive the restart -------------------------------
  r = await sFetch(base, phone, "POST", "/session/prompt", { project: "projA", text: "restart probe", _op: "op-restart-probe" });
  ok("prompt queued by phone approver", r.status === 200 && r.json.status === "queued" && r.json.id > 0, JSON.stringify(r.json));
  const probeId = r.json.id;
  const dup = await sFetch(base, phone, "POST", "/session/prompt", { project: "projA", text: "restart probe", _op: "op-restart-probe" });
  ok("_op replay returns the same id, no double queue", dup.json.id === probeId, JSON.stringify(dup.json));
  await sleep(1300);   // let the JSON store's 1s persist tick land before the kill

  // ---- restart: chat mirror is memory-only, the queue is not -----------------
  await hub.stop();
  hub = await startTestHub({ dir, env });
  base = hub.base;
  r = await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s2", total: 0, turns: [] });
  ok("after restart the have answer is 0", r.status === 200 && r.json.have === 0, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", "/session/chat?project=projA");
  ok("after restart the mirror is empty", r.status === 200 && r.json.turns.length === 0, JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${probeId}`);
  ok("queued prompt survives the restart", r.status === 200 && r.json.status === "queued", JSON.stringify(r.json));

  // ---- scope: projA keys never touch projB ----------------------------------
  r = await sFetch(base, reader, "GET", "/session/chat?project=projB");
  ok("projA reader cannot read projB chat", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/session/chat", { project: "projB", session: "x", total: 1, turns: [turn(0, "hi")] });
  ok("projA approver cannot publish projB chat", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/session/prompt", { project: "projB", text: "cross-project prompt" });
  ok("projA approver cannot prompt projB", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, phone, "GET", `/session/prompts?project=projA`);
  ok("phone approver cannot list the pickup queue (owner-only)", r.status === 403, `status ${r.status}`);

  // ---- prompt lifecycle: claim race, ack outcomes ----------------------------
  r = await sFetch(base, phone, "POST", "/session/prompt", { project: "projA", text: "ship it", _op: "op-ship-it" });
  const shipId = r.json.id;
  ok("second prompt queued", r.status === 200 && shipId > probeId, JSON.stringify(r.json));
  r = await sFetch(base, owner, "GET", "/session/prompts?project=projA&status=queued");
  ok("owner pickup lists both queued prompts with text", r.status === 200 && r.json.prompts.length === 2 && r.json.prompts.every(p => p.text), JSON.stringify(r.json.prompts?.map(p => p.id)));
  const c1 = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: shipId, host: "mac" });
  ok("first claim wins and gets the full text", c1.status === 200 && c1.json.prompt?.text === "ship it", JSON.stringify(c1.json));
  const c2 = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: shipId, host: "mac" });
  ok("second claim gets 409", c2.status === 409, `status ${c2.status}`);
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: shipId, outcome: "delivered" });
  ok("ack delivered lands", r.status === 200 && r.json.status === "delivered", JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${shipId}`);
  ok("phone reads status delivered", r.json.status === "delivered", JSON.stringify(r.json));
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: shipId, outcome: "delivered" });
  ok("re-acking a terminal prompt is 409", r.status === 409, `status ${r.status}`);
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: probeId, host: "mac" });
  ok("probe prompt claims", r.status === 200, `status ${r.status}`);
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: probeId, outcome: "blocked", error: "pane busy" });
  ok("ack blocked marks failed with the outcome", r.status === 200 && r.json.status === "failed", JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${probeId}`);
  ok("phone reads failed + outcome + error", r.json.status === "failed" && r.json.outcome === "blocked" && r.json.error === "pane busy", JSON.stringify(r.json));
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: probeId, outcome: "bogus" });
  ok("unknown outcome is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/session/prompt/claim", { id: probeId, host: "phone" });
  ok("phone approver cannot claim (owner-only)", r.status === 403, `status ${r.status}`);

  // ---- /session/answer: the phone's pick joins the same queue as kind answer (#12137) ------
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", toolId: "toolu_ask1", picks: [1, 2], _op: "op-answer-1" });
  ok("answer queued by phone approver", r.status === 200 && r.json.status === "queued" && r.json.id > 0, JSON.stringify(r.json));
  const answerId = r.json.id;
  const dupAnswer = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", toolId: "toolu_ask1", picks: [1, 2], _op: "op-answer-1" });
  ok("_op replay returns the same answer id", dupAnswer.json.id === answerId, JSON.stringify(dupAnswer.json));
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", picks: [1] });
  ok("answer without toolId is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", toolId: "toolu_empty" });
  ok("answer with neither picks nor other is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", toolId: "toolu_many", picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  ok("picks are capped at 10", r.status === 200, `status ${r.status}`);
  const manyId = r.json.id;
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projB", session: "s9", toolId: "toolu_cross", picks: [0] });
  ok("projA approver cannot answer projB", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, owner, "GET", "/session/prompts?project=projA&status=queued");
  const answerRow = (r.json.prompts || []).find(p => p.id === answerId);
  ok("pickup lists the answer with kind, session, toolId and picks",
    answerRow?.kind === "answer" && answerRow.session === "s9" && answerRow.toolId === "toolu_ask1"
    && JSON.stringify(answerRow.picks) === "[1,2]", JSON.stringify(answerRow));
  ok("plain prompts list as kind prompt", (r.json.prompts || []).filter(p => p.id !== answerId && p.id !== manyId).every(p => p.kind === "prompt"),
    JSON.stringify((r.json.prompts || []).map(p => [p.id, p.kind])));
  const manyRow = (r.json.prompts || []).find(p => p.id === manyId);
  ok("capped picks visible in the queue view", manyRow?.picks?.length === 10, JSON.stringify(manyRow?.picks));
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: answerId, host: "mac" });
  ok("claim carries the full answer payload",
    r.status === 200 && r.json.prompt?.kind === "answer" && r.json.prompt.toolId === "toolu_ask1"
    && JSON.stringify(r.json.prompt.picks) === "[1,2]" && r.json.prompt.session === "s9", JSON.stringify(r.json.prompt));
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: answerId, outcome: "stale", error: "That question was already answered or replaced." });
  ok("ack stale lands as failed with the error kept", r.status === 200 && r.json.status === "failed", JSON.stringify(r.json));
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${answerId}`);
  ok("phone reads the stale outcome", r.json.status === "failed" && r.json.outcome === "stale" && r.json.error.includes("already answered"), JSON.stringify(r.json));
  r = await sFetch(base, phone, "POST", "/session/answer", { project: "projA", session: "s9", toolId: "toolu_other", other: "do it differently", _op: "op-answer-other" });
  ok("other-only answer queues with the text as summary", r.status === 200 && r.json.id > 0, JSON.stringify(r.json));
  const otherId = r.json.id;
  r = await sFetch(base, owner, "POST", "/session/prompt/claim", { id: otherId, host: "mac" });
  ok("claim of an other-answer carries the text", r.json.prompt?.other === "do it differently" && r.json.prompt.text === "do it differently", JSON.stringify(r.json.prompt));
  r = await sFetch(base, owner, "POST", "/session/prompt/ack", { id: otherId, outcome: "delivered" });
  ok("other-answer acks delivered", r.status === 200 && r.json.status === "delivered", JSON.stringify(r.json));
  r = await sFetch(base, owner, "GET", "/events?project=projA&type=chat.prompt.queued&limit=2000");
  const answerEv = (r.json.events || []).find(e => e.promptId === answerId);
  ok("answer queueing is audited with kind and toolId", answerEv?.kind === "answer" && answerEv.toolId === "toolu_ask1", JSON.stringify(answerEv));

  // ---- streams: frames reach only scoped readers -----------------------------
  const ownerStream = await openStream(base, owner, "owner");
  const readerStream = await openStream(base, reader, "readerA");
  ok("streams open", ownerStream.status === 200 && readerStream.status === 200);
  await sleep(150);
  await sFetch(base, owner, "POST", "/session/chat", { project: "projA", session: "s9", total: 1, turns: [turn(0, "stream probe A")] });
  await sFetch(base, owner, "POST", "/session/chat", { project: "projB", session: "s9", total: 1, turns: [turn(0, "stream probe B")] });
  await sFetch(base, phone, "POST", "/session/prompt", { project: "projA", text: "stream prompt", _op: "op-stream-prompt" });
  await sleep(400);
  ok("owner stream sees chat.updated for both projects",
    ownerStream.buf.includes('"chat.updated"') && ownerStream.buf.includes('"projA"') && ownerStream.buf.includes('"projB"'));
  ok("owner stream sees chat.prompt", ownerStream.buf.includes('"chat.prompt"'));
  ok("reader stream sees the projA chat.updated", readerStream.buf.includes('"chat.updated"') && readerStream.buf.includes('"projA"'));
  ok("reader stream never sees projB frames", !readerStream.buf.includes("projB"));
  ok("reader stream sees the projA chat.prompt", readerStream.buf.includes('"chat.prompt"'));
  ownerStream.close(); readerStream.close();

  // ---- the event log carries audit events, never chat.updated -----------------
  r = await sFetch(base, owner, "GET", "/events?project=projA&limit=2000");
  const types = (r.json.events || []).map(e => e.type);
  ok("event log carries chat.prompt.queued/delivered/failed",
    types.includes("chat.prompt.queued") && types.includes("chat.prompt.delivered") && types.includes("chat.prompt.failed"), types.join(","));
  ok("event log never carries chat.updated", !types.includes("chat.updated"));
  const queuedEv = (r.json.events || []).find(e => e.type === "chat.prompt.queued" && e.promptId === shipId);
  ok("queued event truncates text and names the phone", queuedEv && queuedEv.by === "phone" && String(queuedEv.text || "").length <= 500, JSON.stringify(queuedEv));

  // ---- expiry: an unclaimed prompt expires with the relay reason --------------
  await hub.stop();
  hub = await startTestHub({ dir, env: { ...env, RELAY_PROMPT_TTL_MS: "800", RELAY_PROMPT_SWEEP_MS: "300" } });
  base = hub.base;
  r = await sFetch(base, phone, "POST", "/session/prompt", { project: "projA", text: "nobody home", _op: "op-expire" });
  const expId = r.json.id;
  ok("doomed prompt queued", r.status === 200 && expId > 0, JSON.stringify(r.json));
  await sleep(1300);   // past the 800ms TTL; the sweep (300ms) does the lazy read's work
  r = await sFetch(base, phone, "GET", `/session/prompt?id=${expId}`);
  ok("unclaimed prompt expires with the No-Mac reason",
    r.json.status === "expired" && r.json.error === "No Mac is relaying this project. Is the Trantor app open?", JSON.stringify(r.json));
  r = await sFetch(base, owner, "GET", "/events?project=projA&type=chat.prompt.failed&limit=2000");
  ok("expiry is audit-appended as chat.prompt.failed", (r.json.events || []).some(e => e.promptId === expId && e.outcome === "expired"), JSON.stringify(r.json.events?.map(e => e.promptId)));
} finally {
  await hub.stop();
}

// ---- ask blocks raise pushes: one ask.opened per toolId, cleared by ask.answered (#12137) ---
console.log("# ask push wiring on the chat mirror");
{
  const pushed = [];
  const logged = [];
  const rt = createSessionRuntime({
    state: { sessionPrompts: [] }, markDirty: () => {},
    appendEvent: (type) => logged.push(type),
    pushEventToStreams: () => {},
    notifier: { notify: async (event) => { pushed.push(event); } },
  });
  // mergeChat is route-internal; drive it through route() the way the hub does.
  async function merge(b) {
    let out = null;
    await rt.route({
      req: { method: "POST" }, res: {}, q: {}, P: "/session/chat", auth: { identity: { name: "mac" } },
      ctx: { body: async () => b, json: (res, code, body) => { out = { code, body }; return true; }, canon: (x) => x },
    });
    return out;
  }
  const askTurn = (answer) => {
    const block = { kind: "tool", tool: "AskUserQuestion", tool_id: "toolu_1", ask: [{ question: "Ship it?" }] };
    if (answer) block.answer = answer;
    return { idx: 0, role: "assistant", blocks: [block] };
  };
  const publish = (turns, session = "s1") => merge({ project: "askproj", session, total: turns.length, turns, host: "mac" });
  const r0 = await publish([askTurn(null)]);
  ok("publish with an unanswered ask returns ok", r0?.code === 200, JSON.stringify(r0));
  await sleep(20);
  ok("one ask.opened push with the first question text",
    pushed.length === 1 && pushed[0].type === "ask.opened" && pushed[0].toolId === "toolu_1"
    && pushed[0].project === "askproj" && pushed[0].question === "Ship it?" && pushed[0].by === "mac", JSON.stringify(pushed));
  await publish([askTurn(null)]);
  await sleep(20);
  ok("republishing the same open ask does not re-alert", pushed.length === 1, `got ${pushed.length}`);
  await publish([askTurn("Yes, ship it")]);
  await sleep(20);
  ok("the block gaining an answer emits ask.answered once",
    pushed.length === 2 && pushed[1].type === "ask.answered" && pushed[1].toolId === "toolu_1", JSON.stringify(pushed));
  await publish([askTurn("Yes, ship it")]);
  await sleep(20);
  ok("an answered block never re-alerts or re-clears", pushed.length === 2, `got ${pushed.length}`);
  // the kind:"ask" wire variant alerts too, keyed on toolId
  await publish([{ idx: 1, role: "assistant", blocks: [{ kind: "ask", toolId: "toolu_2", text: "Plain ask?" }] }]);
  await sleep(20);
  ok("a kind:ask block alerts with its text as the question",
    pushed.length === 3 && pushed[2].type === "ask.opened" && pushed[2].question === "Plain ask?", JSON.stringify(pushed[2]));
  // a session switch forgets the old asks; the same toolId alerts again under the new session
  await publish([askTurn(null)], "s2");
  await sleep(20);
  ok("a session switch re-arms the dedupe", pushed.length === 4 && pushed[3].type === "ask.opened" && pushed[3].toolId === "toolu_1", `got ${pushed.length}`);
  ok("ask events never touch the audit log", !logged.some(t => String(t).startsWith("ask.")), logged.join(","));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
