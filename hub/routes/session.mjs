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
const ACK_OUTCOMES = new Set(["delivered", "blocked", "not_ready", "stalled", "no_agent", "stale"]);
const ANSWER_PICKS_MAX = 10;
const ANSWER_OTHER_MAX = 2000;
// #12140: crew commands from the phone. The hub validates and queues; the desktop relay runs the
// trantor CLI and acks done|failed with the output tail. A seat spec is "agent[:project]".
const CREW_SPEC = /^[a-z][a-z0-9-]{0,30}(:[A-Za-z0-9._/-]{1,80})?$/;
const CREW_SEATS_MAX = 6;
const CREW_OUTPUT_MAX = 2000;   // the CLI's LAST 2000 chars, ANSI stripped
const CREW_CLAUDE_REFUSAL = "The claude seat draws your own Claude quota; start it on the Mac.";
// oxlint-disable-next-line no-control-regex -- stripping ANSI escape sequences IS matching control characters
const stripAnsi = (s) => String(s).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");

export function createSessionRuntime({ state, markDirty, appendEvent, pushEventToStreams, notifier }) {
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
      asked.delete(project);   // a session switch orphans the old asks; its alerts go stale on the phone
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
    scanAsks(m, project);
    return { code: 200, body: { ok: true, have: m.have } };
  }

  // #12137: an unanswered AskUserQuestion block in the mirror raises ONE push per tool id
  // ("<project> asks: <question>"); when the desktop republishes the block with its answer, the
  // phone's alert is silently cleared. Dedupe is in-memory like the mirror itself, and ask events
  // never touch the audit log — the prompt queue already carries the durable record.
  const asked = new Map();     // project -> Set(toolId) alerted and still unanswered
  function askNotify(event) {
    try { notifier?.notify(event)?.catch?.(() => {}); } catch {}
  }
  function firstQuestion(blk) {
    const a = blk?.ask;
    if (Array.isArray(a) && a.length) return String(a[0]?.question ?? a[0] ?? "").slice(0, 300);
    return String(blk?.text || "").slice(0, 300);
  }
  function scanAsks(m, project) {
    if (!notifier) return;
    for (const t of m.turns.values()) {
      for (const blk of t.blocks) {
        if (!blk || (blk.kind !== "ask" && !blk.ask)) continue;
        const toolId = String(blk.toolId || blk.tool_id || "").slice(0, 200);
        if (!toolId) continue;
        let seen = asked.get(project);
        if (blk.answer) {
          if (seen?.has(toolId)) {
            seen.delete(toolId);
            askNotify({ type: "ask.answered", project, by: m.host, toolId });
          }
        } else if (!seen?.has(toolId)) {
          if (!seen) { seen = new Set(); asked.set(project, seen); }
          seen.add(toolId);
          askNotify({ type: "ask.opened", project, by: m.host, toolId, question: firstQuestion(blk) });
        }
      }
    }
  }

  // #12140: the desktop publishes the seats its Mac can spawn (from `trantor provider status
  // --json`) at boot and every 10 minutes. Memory-only like the chat mirror — a restarted hub
  // has no roster until the desktop republishes.
  const roster = new Map();     // machine -> { machine, updatedAt, seats }

  async function route({ req, res, q, P, auth, ctx }) {
    const isChat = P === "/session/chat";
    const isPrompts = P === "/session/prompts";
    const isPrompt = P === "/session/prompt" || P === "/session/prompt/claim" || P === "/session/prompt/ack";
    const isAnswer = P === "/session/answer";
    const isCrewCommand = P === "/crew/command";
    const isCrewRoster = P === "/crew/roster";
    if (!isChat && !isPrompts && !isPrompt && !isAnswer && !isCrewCommand && !isCrewRoster) return false;
    const { body, json, canon, scopeAllows } = ctx;

    // #12137: the phone's answer to an AskUserQuestion joins the SAME queue as a plain prompt,
    // as kind "answer" — same claim, ack, expiry and audit trail; the desktop relay maps the
    // picks to keystrokes and types them, or acks "stale" when the ask is gone.
    if (req.method === "POST" && isAnswer) {
      const b = await body(req);
      const project = canon(String(b.project || "").slice(0, 80));
      const session = String(b.session || "").slice(0, 200);
      const toolId = String(b.toolId || "").slice(0, 200);
      if (!project) return json(res, 400, { error: "project required" });
      if (!session) return json(res, 400, { error: "session required" });
      if (!toolId) return json(res, 400, { error: "toolId required" });
      const picks = (Array.isArray(b.picks) ? b.picks : []).map(Number).filter(Number.isInteger).slice(0, ANSWER_PICKS_MAX);
      const other = String(b.other || "").slice(0, ANSWER_OTHER_MAX);
      if (!picks.length && !other.trim()) return json(res, 400, { error: "picks or other required" });
      expireQueued();
      state.sessionPromptSeq += 1;
      const text = other.trim() ? other : `picks ${picks.join(", ")}`;
      const p = { id: state.sessionPromptSeq, project, kind: "answer", session, toolId, picks, other,
        text, by: String(auth?.identity?.name || "").slice(0, 120), ts: now(), status: "queued" };
      state.sessionPrompts.push(p);
      while (state.sessionPrompts.length > PROMPT_CAP) {
        const ti = state.sessionPrompts.findIndex(x => x.status !== "queued" && x.status !== "claimed");
        state.sessionPrompts.splice(ti >= 0 ? ti : 0, 1);
      }
      markDirty();
      appendEvent("chat.prompt.queued", project, p.by, { promptId: p.id, kind: "answer", toolId, text: text.slice(0, EVENT_TEXT_MAX) });
      pushEventToStreams({ ts: p.ts, type: "chat.prompt", id: p.id, project });
      return json(res, 200, { id: p.id, status: "queued" });
    }

    // #12140: the phone drives crew lifecycle through the SAME prompt queue as chat prompts and
    // answers, as kind "crew" — same claim, ack, TTL expiry and audit trail. The hub validates the
    // specs and refuses the dangerous shapes; the desktop relay re-validates and runs the CLI.
    if (req.method === "POST" && isCrewCommand) {
      const b = await body(req);
      const project = canon(String(b.project || "").slice(0, 80));
      if (!project) return json(res, 400, { error: "project required" });
      // Approver or owner on the project — authorize() only proves write for an unknown POST path.
      if (!scopeAllows(auth?.identity, project, "approver")) return json(res, 403, { error: "approver role required" });
      const action = String(b.action || "");
      if (!["up", "down", "swap"].includes(action)) return json(res, 400, { error: "action must be up, down or swap" });
      const seats = (Array.isArray(b.seats) ? b.seats : []).map(s => String(s ?? "").slice(0, 120));
      if (seats.length > CREW_SEATS_MAX) return json(res, 400, { error: `at most ${CREW_SEATS_MAX} seats per command` });
      const from = String(b.from || "").slice(0, 120);
      const to = String(b.to || "").slice(0, 120);
      const specs = [...seats, from, to].filter(Boolean);
      const flagged = specs.find(v => v.startsWith("-"));
      if (flagged) return json(res, 400, { error: `flag-like value refused: ${flagged}` });
      const invalid = specs.find(v => !CREW_SPEC.test(v));
      if (invalid) return json(res, 400, { error: `invalid seat spec: ${invalid}` });
      // numbered claude seats (claude-2) draw the same quota as claude
      if (specs.some(v => /^claude(-\d+)?$/.test(v.split(":")[0]))) return json(res, 400, { error: CREW_CLAUDE_REFUSAL });
      if (action === "up" && !seats.length) return json(res, 400, { error: "up needs at least one seat" });
      if (action === "swap" && (!from || !to)) return json(res, 400, { error: "swap needs from and to" });
      expireQueued();
      state.sessionPromptSeq += 1;
      // down with an empty seat list means the whole project.
      const text = action === "swap" ? `swap ${from} ${to}` : seats.length ? `${action} ${seats.join(" ")}` : `${action} ${project}`;
      const p = { id: state.sessionPromptSeq, project, kind: "crew", action, seats, text,
        by: String(auth?.identity?.name || "").slice(0, 120), ts: now(), status: "queued" };
      if (from) p.from = from;
      if (to) p.to = to;
      state.sessionPrompts.push(p);
      while (state.sessionPrompts.length > PROMPT_CAP) {
        const ti = state.sessionPrompts.findIndex(x => x.status !== "queued" && x.status !== "claimed");
        state.sessionPrompts.splice(ti >= 0 ? ti : 0, 1);
      }
      markDirty();
      appendEvent("chat.prompt.queued", project, p.by, { promptId: p.id, kind: "crew", action, text: text.slice(0, EVENT_TEXT_MAX) });
      pushEventToStreams({ ts: p.ts, type: "chat.prompt", id: p.id, project });
      return json(res, 200, { id: p.id, status: "queued" });
    }

    // The roster row is keyed on the SIGNER's identity name (any body machine is
    // ignored) so it matches the chat mirror's host.
    if (req.method === "POST" && isCrewRoster) {
      const b = await body(req);
      if (!scopeAllows(auth?.identity, "", "owner")) return json(res, 403, { error: "owner role required" });
      const machine = String(auth?.identity?.name || b.machine || "").slice(0, 120);
      if (!machine) return json(res, 400, { error: "machine required" });
      const seats = (Array.isArray(b.seats) ? b.seats : []).slice(0, 50).map(s => ({
        agent: String(s?.agent || "").slice(0, 40),
        label: String(s?.label || "").slice(0, 120),
        plan: String(s?.plan || "").slice(0, 40),
        metered: !!s?.metered,
        available: !!s?.available,
        reason: String(s?.reason || "").slice(0, 200),
      })).filter(s => s.agent);
      roster.set(machine, { machine, updatedAt: now(), seats });
      return json(res, 200, { ok: true, machine, seats: seats.length });
    }

    if (req.method === "GET" && isCrewRoster) {
      return json(res, 200, { machines: [...roster.values()] });
    }

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

    // The public view of a queue row: plain prompts are kind "prompt"; answers carry their
    // session, toolId, picks and other; crew commands carry action, seats, from and to —
    // so the claiming desktop has everything it needs.
    const promptView = (p) => {
      const view = { id: p.id, project: p.project, text: p.text, by: p.by, ts: p.ts, status: p.status, kind: p.kind || "prompt" };
      if (p.kind === "answer") {
        view.session = p.session; view.toolId = p.toolId; view.picks = p.picks;
        if (p.other && p.other.trim()) view.other = p.other;   // absent, never "", when nothing was typed
      }
      if (p.kind === "crew") {
        view.action = p.action; view.seats = p.seats;
        if (p.from) view.from = p.from;
        if (p.to) view.to = p.to;
      }
      return view;
    };

    if (req.method === "GET" && isPrompts) {
      expireQueued();
      const project = canon(String(q.project || "").slice(0, 80));
      const status = String(q.status || "").slice(0, 40);
      const prompts = state.sessionPrompts
        .filter(p => (!project || p.project === project) && (!status || p.status === status))
        .map(promptView);
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
      return json(res, 200, { ok: true, prompt: promptView(p) });
    }

    if (req.method === "POST" && P === "/session/prompt/ack") {
      const b = await body(req);
      const p = findPrompt(b.id);
      if (!p) return json(res, 404, { error: "prompt not found" });
      const outcome = String(b.outcome || "");
      // #12140: a crew command acks done|failed with the CLI output tail, and the status IS the
      // outcome — never "delivered". Other kinds keep the delivered/blocked/… vocabulary.
      if (p.kind === "crew") {
        if (outcome !== "done" && outcome !== "failed") return json(res, 400, { error: "crew outcome must be done or failed" });
      } else if (!ACK_OUTCOMES.has(outcome)) {
        return json(res, 400, { error: `outcome must be one of: ${[...ACK_OUTCOMES].join(", ")}` });
      }
      if (p.status === "delivered" || p.status === "done" || p.status === "failed" || p.status === "expired") {
        return json(res, 409, { error: `prompt already ${p.status}`, status: p.status });
      }
      const error = String(b.error || "").slice(0, EVENT_TEXT_MAX);
      p.outcome = outcome; p.error = error; p.ackedAt = now();
      if (p.kind === "crew") {
        p.output = stripAnsi(String(b.output || "")).slice(-CREW_OUTPUT_MAX);
        p.status = outcome;   // "done" or "failed"
      } else {
        p.status = outcome === "delivered" ? "delivered" : "failed";
      }
      markDirty();
      const extra = { promptId: p.id, outcome };
      if (error) extra.error = error;
      appendEvent(p.status === "failed" ? "chat.prompt.failed" : "chat.prompt.delivered", p.project,
        String(auth?.identity?.name || ""), extra);
      return json(res, 200, { ok: true, status: p.status });
    }

    if (req.method === "GET" && P === "/session/prompt") {
      expireQueued();
      const p = findPrompt(q.id);
      if (!p) return json(res, 404, { error: "prompt not found" });
      return json(res, 200, { id: p.id, status: p.status, outcome: p.outcome || "", output: p.output || "", error: p.error || "" });
    }

    return false;
  }

  return { route, expireQueued };
}
