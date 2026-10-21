// #12129: the hub is the meeting point between the desktop relay and the phone. The chat mirror
// is MEMORY-ONLY (a restart answers have:0, the desktop resends its window); the prompt queue
// lives in state so a restart never strands a queued prompt. Live frames ride pushEventToStreams
// (scope-filtered, never logged); only chat.prompt.queued/.delivered/.failed are audit-appended.
import { setInterval } from "node:timers";

const CHAT_CAP = 400;            // turns kept per project, highest idx wins
const CHAT_PAGE = 200;           // max turns per GET
const PROMPT_CAP = 200;
const PROMPT_TEXT_MAX = 8000;
const EVENT_TEXT_MAX = 500;
const PROMPT_TTL_MS = Number(process.env.RELAY_PROMPT_TTL_MS || 120000);
const PROMPT_SWEEP_MS = Number(process.env.RELAY_PROMPT_SWEEP_MS || 30000);
const EXPIRED_REASON = "No Mac is relaying this project. Is the Trantor app open?";
const ACK_OUTCOMES = new Set(["delivered", "blocked", "not_ready", "stalled", "no_agent"]);

export function createSessionRuntime({ state, markDirty, appendEvent, pushEventToStreams }) {
  const now = () => Date.now();
  const mirrors = new Map();     // project -> { session, total, turns: Map(idx->turn), have, meta, updatedAt, host }
  state.sessionPrompts ||= [];
  state.sessionPromptSeq = Number(state.sessionPromptSeq || 0);

  const findPrompt = (id) => state.sessionPrompts.find(p => p.id === Number(id));

  // A prompt still queued past the TTL means no desktop relay claimed it. Expiry is lazy (on
  // read) plus a sweep that is a no-op when nothing is queued, so an idle hub does no work.
  function expireQueued() {
    let changed = false;
    for (const p of state.sessionPrompts) {
      if (p.status !== "queued" || now() - p.ts <= PROMPT_TTL_MS) continue;
      p.status = "expired"; p.outcome = "expired"; p.error = EXPIRED_REASON;
      appendEvent("chat.prompt.failed", p.project, p.by, { promptId: p.id, outcome: "expired", error: EXPIRED_REASON });
      changed = true;
    }
    if (changed) markDirty();
    return changed;
  }
  const sweep = setInterval(() => {
    if (state.sessionPrompts.some(p => p.status === "queued")) expireQueued();
  }, PROMPT_SWEEP_MS);
  sweep.unref?.();

  function mergeChat(b, auth) {
    const project = String(b.project || "").slice(0, 80);
    const session = String(b.session || "").slice(0, 200);
    if (!project) return { code: 400, body: { error: "project required" } };
    if (!session) return { code: 400, body: { error: "session required" } };
    let m = mirrors.get(project);
    // A different session resets the mirror (handoff/compaction): the desktop then sends its
    // whole window, and stale turns from the previous session must not survive the switch.
    if (!m || m.session !== session) {
      m = { session, total: 0, turns: new Map(), have: 0, meta: {}, updatedAt: 0, host: "" };
      mirrors.set(project, m);
    }
    // The last turn grows while the assistant writes, so the desktop resends from the lowest
    // changed idx and the hub REPLACES by idx — re-sends are idempotent by construction.
    for (const t of Array.isArray(b.turns) ? b.turns : []) {
      const idx = Number(t?.idx);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const clean = {
        idx,
        role: String(t.role || "").slice(0, 40),
        blocks: Array.isArray(t.blocks) ? t.blocks : [],
      };
      if (t.queued) clean.queued = true;
      m.turns.set(idx, clean);
      if (idx + 1 > m.have) m.have = idx + 1;
    }
    if (m.turns.size > CHAT_CAP) {
      const drop = [...m.turns.keys()].sort((a, b) => a - b).slice(0, m.turns.size - CHAT_CAP);
      for (const k of drop) m.turns.delete(k);
    }
    m.total = Math.max(0, Number(b.total) || 0);
    // Property access on a primitive is safe (undefined); only null/undefined would throw.
    const meta = b.meta || {};
    m.meta = {
      working: !!meta.working,
      model: String(meta.model || "").slice(0, 120),
      context: meta.context ?? null,
    };
    m.updatedAt = now();
    m.host = String(b.host || auth?.identity?.name || "").slice(0, 120);
    pushEventToStreams({ ts: m.updatedAt, type: "chat.updated", project, total: m.total, working: m.meta.working });
    return { code: 200, body: { ok: true, have: m.have } };
  }

  async function route({ req, res, q, P, auth, ctx }) {
    const isChat = P === "/session/chat";
    const isPrompts = P === "/session/prompts";
    const isPrompt = P === "/session/prompt" || P === "/session/prompt/claim" || P === "/session/prompt/ack";
    if (!isChat && !isPrompts && !isPrompt) return false;
    const { body, json, canon } = ctx;

    if (req.method === "POST" && isChat) {
      const b = await body(req);
      // the same canon the GET reads with, or a publish and a read could name two mirrors
      b.project = canon(String(b.project || "").slice(0, 80));
      const r = mergeChat(b, auth);
      return json(res, r.code, r.body);
    }

    if (req.method === "GET" && isChat) {
      const project = canon(String(q.project || "").slice(0, 80));
      const m = mirrors.get(project);
      if (!m) return json(res, 200, { session: "", total: 0, turns: [], meta: {}, updatedAt: 0, host: "" });
      const afterRaw = Number(q.after);
      const after = Number.isFinite(afterRaw) ? afterRaw : -1;
      const turns = [...m.turns.values()].filter(t => t.idx > after).sort((a, b) => a.idx - b.idx).slice(0, CHAT_PAGE);
      return json(res, 200, { session: m.session, total: m.total, turns, meta: m.meta, updatedAt: m.updatedAt, host: m.host });
    }

    if (req.method === "POST" && P === "/session/prompt") {
      const b = await body(req);
      const project = canon(String(b.project || "").slice(0, 80));
      const text = String(b.text || "");
      if (!project || !text.trim()) return json(res, 400, { error: "project and non-empty text required" });
      if (text.length > PROMPT_TEXT_MAX) return json(res, 400, { error: `text must be <= ${PROMPT_TEXT_MAX} chars` });
      expireQueued();
      state.sessionPromptSeq += 1;
      const p = { id: state.sessionPromptSeq, project, text, by: String(auth?.identity?.name || "").slice(0, 120), ts: now(), status: "queued" };
      state.sessionPrompts.push(p);
      // Cap: evict oldest terminal rows first so live work is never the first casualty.
      while (state.sessionPrompts.length > PROMPT_CAP) {
        const ti = state.sessionPrompts.findIndex(x => x.status !== "queued" && x.status !== "claimed");
        state.sessionPrompts.splice(ti >= 0 ? ti : 0, 1);
      }
      markDirty();
      appendEvent("chat.prompt.queued", project, p.by, { promptId: p.id, text: text.slice(0, EVENT_TEXT_MAX) });
      pushEventToStreams({ ts: p.ts, type: "chat.prompt", id: p.id, project });
      return json(res, 200, { id: p.id, status: "queued" });
    }

    if (req.method === "GET" && isPrompts) {
      expireQueued();
      const project = canon(String(q.project || "").slice(0, 80));
      const status = String(q.status || "").slice(0, 40);
      const prompts = state.sessionPrompts
        .filter(p => (!project || p.project === project) && (!status || p.status === status))
        .map(p => ({ id: p.id, project: p.project, text: p.text, by: p.by, ts: p.ts, status: p.status }));
      return json(res, 200, { prompts });
    }

    if (req.method === "POST" && P === "/session/prompt/claim") {
      const b = await body(req);
      expireQueued();
      const p = findPrompt(b.id);
      if (!p) return json(res, 404, { error: "prompt not found" });
      // The first claim wins; a second claim — even from the same host — gets 409.
      if (p.status !== "queued") return json(res, 409, { error: `prompt already ${p.status}`, status: p.status });
      p.status = "claimed"; p.host = String(b.host || "").slice(0, 120); p.claimedAt = now();
      markDirty();
      // The full text goes only to the claimer.
      return json(res, 200, { ok: true, prompt: { id: p.id, project: p.project, text: p.text, by: p.by, ts: p.ts } });
    }

    if (req.method === "POST" && P === "/session/prompt/ack") {
      const b = await body(req);
      const p = findPrompt(b.id);
      if (!p) return json(res, 404, { error: "prompt not found" });
      const outcome = String(b.outcome || "");
      if (!ACK_OUTCOMES.has(outcome)) return json(res, 400, { error: `outcome must be one of: ${[...ACK_OUTCOMES].join(", ")}` });
      if (p.status === "delivered" || p.status === "failed" || p.status === "expired") {
        return json(res, 409, { error: `prompt already ${p.status}`, status: p.status });
      }
      const error = String(b.error || "").slice(0, EVENT_TEXT_MAX);
      p.outcome = outcome; p.error = error; p.ackedAt = now();
      p.status = outcome === "delivered" ? "delivered" : "failed";
      markDirty();
      const extra = { promptId: p.id, outcome };
      if (error) extra.error = error;
      appendEvent(outcome === "delivered" ? "chat.prompt.delivered" : "chat.prompt.failed", p.project,
        String(auth?.identity?.name || ""), extra);
      return json(res, 200, { ok: true, status: p.status });
    }

    if (req.method === "GET" && P === "/session/prompt") {
      expireQueued();
      const p = findPrompt(q.id);
      if (!p) return json(res, 404, { error: "prompt not found" });
      return json(res, 200, { id: p.id, status: p.status, outcome: p.outcome || "", error: p.error || "" });
    }

    return false;
  }

  return { route, expireQueued };
}
