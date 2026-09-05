/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- SAFETY: Card wire envelopes and omission semantics are a compatibility contract; this module is a mechanical extraction with unchanged suites. */
export async function routeCards({ req, res, q, P, auth, ctx }) {
  const {
    state, body, json, crossProjectGuard, touch, canon, filterReadable,
    appendEvent, appendCardEvent, now, markDirty, stripNulText,
    appendTaskLog, appendTaskNote, cleanChecklist, linkCommitToFocus,
    derivePhases, PROPOSAL_CAP, propFp, healthOf, REAP_GRACE_MS, subFp,
    prunePeers, canRead, HUB_VERSION, cmpSemver, isCardEvent, fmtAge, hubSend,
    ONLINE_MS,
  } = ctx;
    if (req.method === "POST" && P === "/task") {           // create a card
      const b = await body(req);
      const cpg = crossProjectGuard(auth, P, b);
      if (!cpg.ok) return json(res, cpg.code, { error: cpg.error });
      touch(b.by, undefined, b.project, undefined, auth);
      if (b.title !== undefined) b.title = stripNulText(b.title);
      if (b.note !== undefined) b.note = stripNulText(b.note);
      const st0 = ["todo","doing","testing","failed","done","blocked"].includes(b.status) ? b.status : "todo";
      // optional historical ts (backfill from git/import) — accept a past epoch-ms; else now().
      const ts0 = (Number.isFinite(b.ts) && b.ts > 0 && b.ts <= now() + 864e5) ? Math.floor(b.ts) : now();
      const proj0 = canon(String(b.project || "").slice(0,80));
      // Rolling dedup for auto cost-tracking sub-agent cards (source:"cc-subagent"). Collapse identical
      // invocations into ONE card per (project + normalized title): bump count, accumulate cost + tokens.
      // Keeps full board/economics visibility without the hundreds-of-dupes explosion in the FLOW view.
      if (b.source === "cc-subagent") {
        // Server-side guard (defense in depth): an OLD client hook can mis-resolve a parent transcript and
        // POST a wildly inflated notional cost. Reject implausible cc-subagent costs here. (Real agents top
        // out ~40M cache-read / ~$30 — see the v0.17.37 fix.)
        const cr = (b.tokens && typeof b.tokens === "object") ? Number(b.tokens.cacheRead) || 0 : 0;
        if (cr > 50e6 || (typeof b.costUsd === "number" && b.costUsd > 50)) {
          b.costUsd = null; b.tokens = null; b.costNote = "rejected-implausible-cost (hub guard)";
        }
        // Native SubagentStart/Stop carry agent_id (robust start↔stop pairing key) + parent (nest the sub-
        // agent under the spawning session's focus card). agentType lets an enrich find its create card.
        const agentId = b.agentId ? String(b.agentId).slice(0, 80) : "";
        const parent = b.parent ? String(b.parent).slice(0, 120) : "";
        const atype = b.agentType ? String(b.agentType).slice(0, 40) : "";
        // ENRICH (native SubagentStart): the sub-agent spawned — attach agent_id + parent to the in-flight
        // "doing" card the PreToolUse create already made. Match the newest agent_id-less doing card for this
        // (project, agentType). If none (a spawn with no matching PreToolUse — rare), CREATE one keyed by
        // agent_id so nothing orphans. Idempotent: a repeat enrich for a known agent_id is a no-op.
        if (b.enrich) {
          if (!agentId) return json(res, 200, { ok: true, ignored: "enrich-without-agentId" });
          const already = state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._aid === agentId);
          if (already) return json(res, 200, { ok: true, task: already, deduped: true, enriched: true });
          const cand = state.tasks
            .filter(x => x.source === "cc-subagent" && x.project === proj0 && !x._aid && x.status === "doing" && (atype ? x._atype === atype : true))
            .sort((a, c) => (c.ts || 0) - (a.ts || 0))[0];
          if (cand) {
            cand._aid = agentId; if (parent && !cand.parent) cand.parent = parent; cand.updated = ts0;
            appendTaskNote(cand, b, ts0);
            markDirty(); return json(res, 200, { ok: true, task: cand, deduped: true, enriched: true });
          }
          const title = String(atype || "subagent").slice(0, 180);
          const t = { id: ++state.taskSeq, project: proj0, title, assignee: `${atype}:${proj0}`,
            status: "doing", phase: "sub-agents", source: "cc-subagent", costKind: "subagent-notional",
            costUsd: null, costNote: "", effort: "", tokens: null, difficulty: "", model: "", deps: [],
            parent: parent || undefined, by: b.by || "", ts: ts0, updated: ts0,
            history: [{ to: "doing", by: b.by || "", ts: ts0 }] };
          t._fp = subFp(title); t._atype = atype; t._aid = agentId; t.count = 1; t._everStarted = true; t._inflight = 1;
          appendTaskNote(t, b, ts0);
          state.tasks.push(t); appendCardEvent("created", t, b.by, null, "doing");
          markDirty(); return json(res, 200, { ok: true, task: t, created: true });
        }
        // A "start" ping (PreToolUse subagent-start.mjs) posts status:"doing" with NO cost/tokens so sub-agent
        // work shows IN PROGRESS while it runs; the SubagentStop "done" post (with cost) flips it.
        const isStart = st0 === "doing" && b.costUsd == null && !b.tokens;
        const fp = subFp(b.title);
        // Pair by agent_id first (robust — survives title differences between start & stop); fall back to the
        // title fingerprint for legacy clients / the PreToolUse-only path that predates agent_id.
        const ex = (agentId && state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._aid === agentId))
          || state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._fp === fp);
        if (ex) {
          if (parent && !ex.parent) ex.parent = parent;
          if (agentId && !ex._aid) ex._aid = agentId;
          if (isStart) {
            // another dispatch of the same sub-agent began — count the invocation, mark in-flight, no cost
            ex.count = (ex.count || 1) + 1;
            ex._inflight = (ex._inflight || 0) + 1; ex._everStarted = true;
            if (ex.status === "done") { (ex.history ||= []).push({ from: "done", to: "doing", by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, "done", "doing"); }
            ex.status = "doing"; ex.ts = ts0; ex.updated = ts0;
            appendTaskNote(ex, b, ts0);
            markDirty(); return json(res, 200, { ok: true, task: ex, deduped: true, count: ex.count, started: true });
          }
          // a completion (SubagentStop) or recost: accumulate cost, retire one in-flight, flip to done when none remain
          if (typeof b.costUsd === "number" && isFinite(b.costUsd)) ex.costUsd = (ex.costUsd || 0) + b.costUsd;
          if (b.tokens && typeof b.tokens === "object") {
            ex.tokens ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
            ex.tokens.input += Number(b.tokens.input) || 0; ex.tokens.output += Number(b.tokens.output) || 0;
            ex.tokens.cacheWrite += Number(b.tokens.cacheWrite) || 0; ex.tokens.cacheRead += Number(b.tokens.cacheRead) || 0;
          }
          if (b.model && !ex.model) ex.model = String(b.model).slice(0, 60);
          // upgrade a bare agentType-only fallback title with the completion's real (prompt-derived) title
          if (b.title && ex._atype && (ex.title === ex._atype) && subFp(b.title) !== subFp(ex.title)) { ex.title = String(b.title).slice(0, 200); ex._fp = subFp(ex.title); }
          if (ex._everStarted) ex._inflight = Math.max(0, (ex._inflight || 1) - 1);
          else ex.count = (ex.count || 1) + 1;   // legacy path: a stop with no prior start (old sessions) still counts the run
          const wasDoing = ex.status === "doing";
          ex.status = (ex._everStarted && ex._inflight > 0) ? "doing" : "done";
          if (wasDoing && ex.status === "done") { (ex.history ||= []).push({ from: "doing", to: "done", by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, "doing", "done"); }
          ex.ts = ts0; ex.updated = ts0;
          appendTaskNote(ex, b, ts0);
          markDirty(); return json(res, 200, { ok: true, task: ex, deduped: true, count: ex.count });
        }
      }
      // Background/child agents (CC Notification hook: agent_needs_input / agent_completed) — the fork/`--agent`/
      // subtask population that never hits the Task-tool sub-agent path. Carded as a DISTINCT source so they
      // never double-count against cc-subagent notional cost. Keyed by agent id to fold needs_input→completed.
      if (b.source === "cc-bg-agent") {
        const bgId = b.agentId ? String(b.agentId).slice(0, 120) : "";
        // never double-card a sub-agent already tracked by SubagentStart/Stop (cc-subagent) — a Notification
        // for the same agent is redundant, so drop it.
        if (bgId && state.tasks.some(x => x.source === "cc-subagent" && x._aid === bgId)) {
          return json(res, 200, { ok: true, ignored: "already-tracked-as-cc-subagent" });
        }
        const nt = String(b.notificationType || "").slice(0, 40);
        const target = nt === "agent_completed" ? "done" : (nt === "agent_needs_input" ? "blocked" : "doing");
        const ex = bgId && state.tasks.find(x => x.source === "cc-bg-agent" && x.project === proj0 && x._aid === bgId);
        if (ex) {
          const from = ex.status; ex.status = target; ex.ts = ts0; ex.updated = ts0;
          if (b.parent && !ex.parent) ex.parent = String(b.parent).slice(0, 120);
          if (b.title && b.title.length > (ex.title || "").length) ex.title = String(b.title).slice(0, 200);
          if (from !== target) { (ex.history ||= []).push({ from, to: target, by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, from, target); }
          appendTaskNote(ex, b, ts0);
          markDirty(); return json(res, 200, { ok: true, task: ex, deduped: true });
        }
        const bt = { id: ++state.taskSeq, project: proj0, title: String(b.title || b.agentType || "background agent").slice(0, 200),
          assignee: String(b.assignee || "").slice(0, 60), status: target, phase: "sub-agents",
          source: "cc-bg-agent", costKind: "", costUsd: null, costNote: "", effort: "", tokens: null,
          difficulty: "", model: "", deps: [], parent: b.parent ? String(b.parent).slice(0, 120) : undefined,
          by: b.by || "", ts: ts0, updated: ts0, history: [{ to: target, by: b.by || "", ts: ts0 }] };
        if (bgId) bt._aid = bgId; if (b.agentType) bt._atype = String(b.agentType).slice(0, 40);
        appendTaskNote(bt, b, ts0);
        state.tasks.push(bt); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
        appendCardEvent("created", bt, b.by, null, target);
        markDirty(); return json(res, 200, { ok: true, task: bt, created: true });
      }
      const t = { id: ++state.taskSeq, project: proj0, title: String(b.title||"").slice(0,200),
        assignee: b.assignee || "", status: st0,
        phase: String(b.phase || "").slice(0, 40),   // explicit phase tag (FLOW v2) — wins over title-prefix inference
        source: String(b.source || "").slice(0, 20), // e.g. "git" (backfill), "todo", "cc-subagent" — provenance
        // economics: how this card's cost should be counted. costKind discriminates the source so the
        // dashboard can show notional (plan-covered) vs real spend inline-but-differentiated.
        costKind: String(b.costKind || "").slice(0, 24),         // subagent-notional|orchestrator-notional|crew-subscription|scrooge-real
        costUsd: (typeof b.costUsd === "number" && isFinite(b.costUsd)) ? b.costUsd : null,
        costNote: String(b.costNote || "").slice(0, 80),
        effort: String(b.effort || "").slice(0, 12),
        tokens: (b.tokens && typeof b.tokens === "object") ? {
          input: Number(b.tokens.input) || 0, output: Number(b.tokens.output) || 0,
          cacheWrite: Number(b.tokens.cacheWrite) || 0, cacheRead: Number(b.tokens.cacheRead) || 0,
        } : null,
        difficulty: ["easy","medium","hard"].includes(b.difficulty) ? b.difficulty : "",
        model: String(b.model || "").slice(0, 60),
        deps: Array.isArray(b.deps) ? [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20) : [],
        by: b.by || "", ts: ts0, updated: ts0,
        history: [{ to: st0, by: b.by || "", ts: ts0 }] };
      { const cl = cleanChecklist(b.checklist); if (cl?.length) t.checklist = cl; }   // #5624 — rides `extra`, survives restarts
      if (b.source === "cc-subagent") { t._fp = subFp(b.title); if (b.agentType) t._atype = String(b.agentType).slice(0, 40); if (b.agentId) t._aid = String(b.agentId).slice(0, 80); if (b.parent) t.parent = String(b.parent).slice(0, 120); t.count = 1; if (t.status === "doing") { t._everStarted = true; t._inflight = 1; } }
      appendTaskNote(t, b, ts0);
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      appendCardEvent("created", t, b.by, null, st0);
      // A COMMIT closes the focus. A focus card says "this session is working on X right now"; the
      // commit is X arriving, so the card that was rolling forever now completes with the commit
      // attached to it — the board finally shows a finished unit of work instead of an open card
      // whose title keeps changing. The next prompt opens a fresh one.
      if (b.source === "git" && st0 === "done") linkCommitToFocus(t, b.by);
      markDirty(); return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      const cpg = crossProjectGuard(auth, P, b);
      if (!cpg.ok) return json(res, cpg.code, { error: cpg.error });
      if (b.title !== undefined) b.title = stripNulText(b.title);
      if (b.note !== undefined) b.note = stripNulText(b.note);
      // Board integrity (#5406): a card can never change hands silently. The assignee is frozen once
      // set; a mutation is legitimate only as a HANDOFF (the current assignee reassigning to someone
      // else) or an EXPLICIT reassign (reassign:true — e.g. the orchestrator re-routing work after a
      // seat dies). A silent third-party overwrite 409s so the caller knows the board refused to move.
      // Runs BEFORE any other field mutation so a refused steal cannot half-apply a status move.
      if (b.assignee !== undefined) {
        const want = String(b.assignee).slice(0, 60);
        if (want !== t.assignee) {
          const mover = String(auth?.identity?.name || b.by || "").slice(0, 120);
          const isOwner = !!t.assignee && mover === t.assignee;
          const explicit = b.reassign === true;
          if (!isOwner && !explicit) {
            return json(res, 409, { error: "assignee is immutable", id: t.id, assignee: t.assignee });
          }
        }
      }
      let eventType = "updated", eventFrom = null, eventTo = null;
      if (b.status && ["todo","doing","testing","failed","done","blocked","stale"].includes(b.status) && b.status !== t.status) {
        eventType = "moved"; eventFrom = t.status; eventTo = b.status;
        (t.history ||= []).push({ from: t.status, to: b.status, by: b.by || "", ts: now() });
        if (t.history.length > 40) t.history.splice(0, 10);
        t.status = b.status;
        // WHO is actually working this card — the SIGNED mover, not the assignee. A card filed by
        // the orchestrator and built by a seat wore the orchestrator's face on every board
        // (2026-08-28, operator caught it: "they all say claude"). The assignee stays intent;
        // workedBy is evidence, stamped only on real work moves and never from a self-asserted by.
        if (["doing","testing","done"].includes(b.status) && auth?.identity?.name) {
          t.workedBy = String(auth.identity.name).slice(0, 120);
        }
      }
      if (b.difficulty && ["easy","medium","hard"].includes(b.difficulty)) t.difficulty = b.difficulty;
      if (b.model !== undefined) t.model = String(b.model).slice(0, 60);
      if (Array.isArray(b.deps)) t.deps = [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== t.id))].slice(0, 20);
      if (b.assignee !== undefined && String(b.assignee).slice(0, 60) !== t.assignee) {
        const prev = t.assignee || "(none)";
        const mover = String(auth?.identity?.name || b.by || "").slice(0, 120);
        t.assignee = String(b.assignee).slice(0, 60);
        // the handover is part of the card's story, not a silent overwrite
        appendTaskLog(t, mover, `reassigned ${prev} → ${t.assignee}${b.reassign === true ? " (explicit)" : " (handoff)"}`, now());
      }
      if (b.title !== undefined) t.title = String(b.title).slice(0,200);
      // the narrative line a human reads on the board ("assigned — did"), written by the cheap
      // summarizer; rides the tasks.extra column, so it survives restarts everywhere
      if (b.summary !== undefined) t.summary = String(b.summary).slice(0, 220);
      // #5624: full checklist replace (null clears). Item-level toggles ride /task/checklist-toggle.
      if (b.checklist !== undefined) {
        const cl = cleanChecklist(b.checklist);
        if (cl) { if (cl.length) t.checklist = cl; else delete t.checklist; }
        else if (b.checklist === null) delete t.checklist;
      }
      appendTaskNote(t, b);
      if (b.delete) { eventType = "deleted"; eventFrom = null; eventTo = null; state.tasks = state.tasks.filter(x => x.id !== t.id); }
      appendCardEvent(eventType, t, b.by, eventFrom, eventTo);
      t.updated = now(); markDirty(); return json(res, 200, { ok: true, task: t });
    }
    // #5624: toggle ONE acceptance item. Index-addressed against the card's current checklist —
    // a stale index 400s instead of silently toggling the wrong item.
    if (req.method === "POST" && P === "/task/checklist-toggle") {
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      const i = Number(b.index);
      if (!Array.isArray(t.checklist) || !Number.isInteger(i) || i < 0 || i >= t.checklist.length) {
        return json(res, 400, { error: "no such checklist item" });
      }
      t.checklist[i].done = !!b.done;
      t.updated = now(); markDirty(); return json(res, 200, { ok: true, task: t });
    }
    // Manual board sweep — the aggressive companion to the automatic reaper. The reaper only touches
    // OFFLINE-owner cards (no false positives on live work); /sweep is the explicit "this live seat forgot
    // its card" path: it stales EVERY doing/testing card untouched past `olderMs`, regardless of owner
    // liveness — so it is preview-first (dryRun returns the candidates and changes nothing; the CLI/dashboard
    // confirm before the real move). Optional `project` scopes it to one board.
    if (req.method === "POST" && P === "/sweep") {
      const b = await body(req);
      const project = b.project ? canon(String(b.project).slice(0, 80)) : null;
      const olderMs = Number.isFinite(Number(b.olderMs)) ? Math.max(0, Number(b.olderMs)) : REAP_GRACE_MS;
      const cut = now() - olderMs;
      const cand = state.tasks.filter(t =>
        (t.status === "doing" || t.status === "testing") &&
        (t.updated || t.ts || 0) < cut &&
        (!project || t.project === project));
      const view = cand.map(t => ({ id: t.id, project: t.project, title: t.title, assignee: t.assignee || "",
        status: t.status, source: t.source || "", ageMs: now() - (t.updated || t.ts || 0) }));
      if (b.dryRun) return json(res, 200, { ok: true, dryRun: true, count: view.length, candidates: view });
      for (const t of cand) {
        (t.history ||= []).push({ from: t.status, to: "stale", by: b.by || "sweep", ts: now() });
        if (t.history.length > 60) t.history.splice(0, 20);
        appendCardEvent("moved", t, b.by || "sweep", t.status, "stale");
        t.status = "stale"; t.updated = now(); t._reaped = true;
      }
      if (cand.length) markDirty();
      return json(res, 200, { ok: true, swept: view.length, candidates: view });
    }
    // Mirror a session's TodoWrite list onto its board as cards, so SOLO work (no crew) shows up live
    // and accrues timeline history. pending/in_progress/completed -> todo/doing/done. Reconciled by
    // todo text per session: present todos create/update; a vanished todo's card is deleted UNLESS it
    // was already done (accomplished work stays in the DONE column). Posted by hooks/todo-sync.mjs.
    if (req.method === "POST" && P === "/todos") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      const project = canon(String(b.project || "").slice(0, 80));
      if (!session || !project) return json(res, 400, { error: "session and project required" });
      touch(session, undefined, project, undefined, auth);
      const ST = { pending: "todo", in_progress: "doing", completed: "done" };
      const todos = Array.isArray(b.todos) ? b.todos : [];
      const mine = state.tasks.filter(t => t.source === "todo" && t.assignee === session && t.project === project);
      const seen = new Set();
      for (const todo of todos) {
        const key = String(todo?.content || "").trim().slice(0, 200);
        if (!key) continue;
        seen.add(key);
        const want = ST[todo.status] || "todo";
        let t = mine.find(c => c.todoKey === key);
        if (!t) {
          t = { id: ++state.taskSeq, project, title: key, assignee: session, status: want, difficulty: "", model: "",
            deps: [], by: session, ts: now(), updated: now(), source: "todo", todoKey: key,
            history: [{ to: want, by: session, ts: now() }] };
          state.tasks.push(t); appendCardEvent("created", t, session, null, want); markDirty();
        } else if (t.status !== want) {
          (t.history ||= []).push({ from: t.status, to: want, by: session, ts: now() });
          if (t.history.length > 40) t.history.splice(0, 10);
          appendCardEvent("moved", t, session, t.status, want); t.status = want; t.updated = now(); markDirty();
        }
      }
      for (const t of mine) {
        if (seen.has(t.todoKey) || t.status === "done") continue;   // keep accomplished work on the board
        state.tasks = state.tasks.filter(x => x.id !== t.id); appendCardEvent("deleted", t, session, null, null); markDirty();
      }
      if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      return json(res, 200, { ok: true, count: todos.length });
    }
    // A REGULAR session's live "focus" card — what THIS session is working on right now, set from each
    // substantive user prompt (hooks/prompt-focus.mjs). ONE rolling "doing" card per session (re-titled as
    // the focus shifts, with a history trail); closed to "done" when the session is pruned offline. This is
    // the bridge that makes a non-crew session's OWN work show IN PROGRESS live, not just at commit time.
    if (req.method === "POST" && P === "/focus") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      const project = canon(String(b.project || "").slice(0, 80));
      const title = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
      // `cc` = the Claude Code session UUID (hooks/prompt-focus.mjs passes session_id). It is the
      // ONLY per-session key on the board: `assignee` is a bus id, which is per host+project, so
      // two Claude sessions in one project used to fight over a single rolling card — and every
      // sub-agent card, whose `parent` is that same UUID, had nothing to join to (measured over
      // 431 live cards, joining on the bus id resolved 0 of them). With `cc` stored here, a
      // sub-agent nests under the session that actually spawned it.
      const cc = String(b.cc || "").slice(0, 120);
      if (!session || !project || !title) return json(res, 400, { error: "session, project, title required" });
      touch(session, undefined, project, undefined, auth);
      // Match on cc when the client sends one — but never let a cc-bearing prompt adopt a card
      // from a DIFFERENT session. A client too old to send cc keeps the original assignee match.
      let t = cc
        ? state.tasks.find(x => x.source === "session" && x.cc === cc && canon(x.project) === project && x.status !== "done")
          || state.tasks.find(x => x.source === "session" && !x.cc && x.assignee === session && canon(x.project) === project && x.status !== "done")
        : state.tasks.find(x => x.source === "session" && x.assignee === session && canon(x.project) === project && x.status !== "done");
      if (t) {
        if (t.title !== title) {            // refocus: re-title in place + record the shift (keeps the trail)
          (t.history ||= []).push({ from: t.status, to: t.status, by: session, ts: now(), note: title.slice(0, 90) });
          if (t.history.length > 60) t.history.splice(0, 20);
          // A rolling card's narrative describes the OLD focus. The board renders `summary ||
          // title`, so leaving it would let a stale one-liner shadow what the session is doing
          // right now — the summarizer (or bin/focus-title.mjs) writes a fresh one.
          if (t.summary) t.summary = "";
          t.title = title; appendCardEvent("updated", t, session, null, null);
          appendEvent("focus", project, session, { taskId: t.id, title, shift: true });
        }
        if (cc && !t.cc) t.cc = cc;          // an in-flight card from an older client gets its key
        t.status = "doing"; t.updated = now();
      } else {
        t = { id: ++state.taskSeq, project, title, assignee: session, status: "doing", source: "session",
          difficulty: "", model: "", deps: [], by: session, ts: now(), updated: now(),
          cc: cc || undefined,
          history: [{ to: "doing", by: session, ts: now() }] };
        state.tasks.push(t); appendCardEvent("created", t, session, null, "doing");
        appendEvent("focus", project, session, { taskId: t.id, title, shift: false });
        if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      }
      markDirty(); return json(res, 200, { ok: true, id: t.id, task: t });
    }
    if (req.method === "GET" && P === "/focus") {     // the session's open focus card (for sub-agent nesting)
      const session = String(q.session || "");
      const cc = String(q.cc || "");
      // ?cc= is the precise lookup (one Claude session); ?session= stays the coarse one.
      const t = cc
        ? state.tasks.find(x => x.source === "session" && x.cc === cc && x.status !== "done")
        : state.tasks.find(x => x.source === "session" && x.assignee === session && x.status !== "done");
      if (t && !canRead(auth, t.project || "")) return json(res, 404, { id: null, task: null });
      return json(res, 200, { id: t ? t.id : null, task: t || null });
    }
    if (req.method === "GET" && P === "/tasks") {
      const proj = q.project ? canon(q.project) : ""; const ts = filterReadable(auth, proj ? state.tasks.filter(t => canon(t.project) === proj) : state.tasks, t => t.project || "");
      return json(res, 200, { tasks: ts });
    }
    if (req.method === "GET" && P === "/history") {
      const requestedLimit = Number(q.limit || 200);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 200, 0), 1000);
      const proj = q.project ? canon(q.project) : "";
      // CARD events only — /history is the TIMELINE's feed and predates the unified log, so it must
      // keep returning exactly what it always did. Everything else lives behind /events.
      const all = state.events.filter(isCardEvent);
      const events = filterReadable(auth, proj ? all.filter(e => canon(e.project) === proj) : all, e => e.project || "").slice(-limit);
      return json(res, 200, { events });
    }
    // The unified log — the FEED's feed. Filters compose (AND): project, type (comma list; a
    // trailing "." is a prefix match, e.g. type=presence.), by (actor), taskId (card thread),
    // since (event id, for incremental polling). Newest-last, like /history.
    if (req.method === "GET" && P === "/events") {
      const requestedLimit = Number(q.limit || 300);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 300, 0), 2000);
      const proj = q.project ? canon(q.project) : "";
      const since = Number(q.since || 0);
      const taskId = q.taskId ? Number(q.taskId) : null;
      const wants = String(q.type || "").split(",").map(s => s.trim()).filter(Boolean);
      const typeOk = (t) => !wants.length || wants.some(w => w.endsWith(".") ? String(t).startsWith(w) : t === w);
      let out = filterReadable(auth, state.events, e => e.project || "").filter(e =>
        (!proj || canon(e.project) === proj) &&
        (!since || e.id > since) &&
        (taskId == null || e.taskId === taskId || (Array.isArray(e.refs) && e.refs.includes(taskId))) &&
        (!q.by || e.by === q.by) &&
        typeOk(e.type));
      out = out.slice(-limit);
      return json(res, 200, { events: out, cursor: out.length ? out[out.length - 1].id : since,
        latest: state.events.length ? state.events[state.events.length - 1].id : 0 });
    }
    // A single card's FULL story for the detail panel: the card itself, its status events, and the
    // bus messages that reference it (#<id>) — i.e. the agent's own reports of what it did, why, how.
    if (req.method === "GET" && P === "/card") {
      const id = Number(q.id);
      if (!Number.isInteger(id)) return json(res, 400, { error: "numeric id required" });
      const task = state.tasks.find(t => t.id === id) || null;
      if (task && !canRead(auth, task.project || "")) return json(res, 404, { task: null, events: [], messages: [] });
      const events = filterReadable(auth, state.events.filter(e => e.taskId === id), e => e.project || "");
      const re = new RegExp("#" + id + "(?![0-9])");   // #5 but not #50
      const messages = filterReadable(auth, state.messages.filter(m => re.test(String(m.text || ""))), m => m.project || "").slice(-200);
      // fall back to the last event for title/project/assignee when the card was deleted
      const last = events[events.length - 1];
      const meta = task || (last ? { id, title: last.title, project: last.project, status: "deleted", assignee: last.assignee, difficulty: last.difficulty } : null);
      return json(res, 200, { task: meta, events, messages });
    }
    if (req.method === "POST" && P === "/project") {        // set a project's brief (what & why)
      const b = await body(req); const k = canon(String(b.project || "").slice(0, 80));
      if (!k) return json(res, 400, { error: "project required" });
      const m = state.projectMeta[k] || {};
      if (b.brief !== undefined) m.brief = String(b.brief).slice(0, 600);
      m.by = b.by || m.by || ""; m.updated = now();
      state.projectMeta[k] = m; markDirty();
      return json(res, 200, { ok: true, project: k, brief: m.brief || "" });
    }
    if (req.method === "POST" && P === "/project/delete") { // forget a project: its cards, peers, brief, and lane
      const b = await body(req); const k = String(b.project || "").slice(0, 80);
      if (!k) return json(res, 400, { error: "project required" });
      const nt = state.tasks.length, np = Object.keys(state.peers).length, nm = state.messages.length;
      state.tasks = state.tasks.filter(t => t.project !== k);
      for (const [s, v] of Object.entries(state.peers)) if (v.project === k) delete state.peers[s];
      delete state.projectMeta[k];
      state.messages = state.messages.filter(m2 => (m2.project || "") !== k);
      // Forget its log too, or the FEED would keep replaying a project the board no longer shows.
      const ne = state.events.length;
      state.events = state.events.filter(e => (e.project || "") !== k);
      markDirty();   // the project reappears cleanly if an agent ever registers it again
      return json(res, 200, { ok: true, project: k, removed: { tasks: nt - state.tasks.length, peers: np - Object.keys(state.peers).length, messages: nm - state.messages.length, events: ne - state.events.length } });
    }
    // Fold one project lane into another: rewrite all stored project fields from→to AND
    // record an alias so future writes under `from` canonicalize to `to`. Idempotent.
    // This is how a fragmented project (one repo, two lane keys) becomes one continuous lane.
    if (req.method === "POST" && P === "/project/merge") {
      const b = await body(req);
      const from = String(b.from || "").slice(0, 80), to = String(b.to || "").slice(0, 80);
      if (!from || !to || from === to) return json(res, 400, { error: "distinct from+to required" });
      let cards = 0, events = 0, peers = 0, msgs = 0;
      for (const t of state.tasks) if (t.project === from) { t.project = to; cards++; }
      for (const e of state.events) if (e.project === from) { e.project = to; events++; }
      for (const v of Object.values(state.peers)) if (v.project === from) { v.project = to; peers++; }
      for (const m of state.messages) if ((m.project || "") === from) { m.project = to; msgs++; }
      if (state.projectMeta[from]) {
        if (!state.projectMeta[to]) state.projectMeta[to] = state.projectMeta[from];
        else if (!state.projectMeta[to].brief && state.projectMeta[from].brief) state.projectMeta[to].brief = state.projectMeta[from].brief;
        delete state.projectMeta[from];
      }
      state.aliases[from] = to;                       // future writes fold automatically
      for (const [k, v] of Object.entries(state.aliases)) if (v === from) state.aliases[k] = to; // re-point chains
      markDirty();
      return json(res, 200, { ok: true, from, to, moved: { cards, events, peers, messages: msgs } });
    }
    // Catch-up snapshot: everything a NEW session needs to resume a project's continuous
    // lane — the brief, card counts, what's in-flight (doing/testing/todo) and the most
    // recent done work, plus last activity. Cheap + LLM-free; the SessionStart hook injects it.
    if (req.method === "GET" && P === "/catchup") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      if (!canRead(auth, proj)) return json(res, 403, { error: "forbidden" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0, stale:0 };
      for (const t of mine) counts[t.status] = (counts[t.status] || 0) + 1;
      const pick = (st, n) => mine.filter(t => t.status === st).sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0, n)
        .map(t => ({ id: t.id, title: t.title, assignee: t.assignee || "", updated: t.updated || 0, source: t.source || "" }));
      const lastActivity = mine.reduce((mx,t)=>Math.max(mx, t.updated||0), state.projectMeta[proj]?.updated || 0);
      return json(res, 200, {
        project: proj, brief: state.projectMeta[proj]?.brief || "",
        counts, total: mine.length,
        doing: pick("doing", 8), testing: pick("testing", 8), failed: pick("failed", 8),
        blocked: pick("blocked", 8), todo: pick("todo", 10), recentDone: pick("done", 8),
        lastActivity,
      });
    }
    // FLOW v2: the orchestrator-rooted phase flowchart. Returns the project's cards grouped into
    // ordered phases (title-prefix + time-cluster), each with its crew fan-out + orchestrator nodes.
    if (req.method === "GET" && P === "/phases") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      if (!canRead(auth, proj)) return json(res, 403, { error: "forbidden" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const out = derivePhases(mine);
      for (const p of out.phases) p.goal = state.phaseMeta[`${proj}::${p.key}`]?.goal || "";   // explicit goal overrides the derived theme
      return json(res, 200, { project: proj, brief: state.projectMeta[proj]?.brief || "", ...out });
    }
    // Set a phase's explicit GOAL — what this phase needs to do (the orchestrator captures this at plan
    // time, like a per-phase brief). Surfaces in the FLOW v2 header in place of the derived theme.
    if (req.method === "POST" && P === "/phase") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80)), phase = String(b.phase || "").slice(0, 40);
      if (!proj || !phase) return json(res, 400, { error: "project + phase required" });
      const k = `${proj}::${phase}`; const m = state.phaseMeta[k] || {};
      if (b.goal !== undefined) m.goal = String(b.goal).slice(0, 400);
      m.by = b.by || m.by || ""; m.updated = now();
      state.phaseMeta[k] = m; markDirty();
      return json(res, 200, { ok: true, project: proj, phase, goal: m.goal || "" });
    }
    if (req.method === "GET" && P === "/projects") {        // project-grouped view
      prunePeers();
      const cutoff = now() - ONLINE_MS; const byProj = {};
      const proj = p => canon(p) || "(unassigned)";
      const mk = k => (byProj[k] ||= { project: k, brief: (state.projectMeta[k]?.brief) || "", agents: [], tasks: { todo:0,doing:0,testing:0,failed:0,done:0,blocked:0 }, doingTitles: [], lastActivity: 0 });
      for (const [s, v] of filterReadable(auth, Object.entries(state.peers), ([, v]) => v.project || "")) {
        const k = proj(v.project); const e = mk(k); e.agents.push({ session: s, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status),
          llm: v.llm || "", model: v.model || "", hookVersion: v.hookVersion || "", staleHooks: !!(v.lastSeen > cutoff && v.hookVersion && HUB_VERSION && cmpSemver(v.hookVersion, HUB_VERSION) < 0) });
        if ((v.lastSeen || 0) > e.lastActivity) e.lastActivity = v.lastSeen;
      }
      for (const t of filterReadable(auth, state.tasks, t => t.project || "")) { const e = mk(proj(t.project)); e.tasks[t.status] = (e.tasks[t.status]||0)+1; if (t.status === "doing") e.doingTitles.push(t.title); if ((t.updated || 0) > e.lastActivity) e.lastActivity = t.updated; }
      // derive a one-line phase ("where it is in the process") from the board
      for (const e of Object.values(byProj)) {
        const mu = state.projectMeta[e.project]?.updated || 0; if (mu > e.lastActivity) e.lastActivity = mu;
        e.idle = !e.agents.some(a => a.online);
        const { todo, doing, testing=0, failed=0, done, blocked } = e.tasks; const total = todo+doing+testing+failed+done+blocked;
        e.phase = total === 0 ? "no cards yet"
          : failed > 0 ? `${failed} FAILED — fixing`
          : blocked > 0 ? `blocked on ${blocked} card${blocked>1?"s":""}`
          : testing > 0 ? `verifying: ${testing} in test`
          : doing > 0 ? `building: ${e.doingTitles.slice(0,2).join(", ")}${e.doingTitles.length>2?"…":""}`
          : done === total ? "shipped — all cards done"
          : todo > 0 ? `planned: ${todo} card${todo>1?"s":""} queued`
          : "in progress";
        // dead board: no live agents -> the phase above is stale, say so honestly
        if (e.idle) e.phase = `idle · last activity ${e.lastActivity ? fmtAge(now() - e.lastActivity) : "unknown"}`;
      }
      return json(res, 200, { projects: Object.values(byProj) });
    }
    // --- lessons: cross-agent learning from failures. scope = "global" or an agent brand ("kimi") ---
    if (req.method === "POST" && P === "/lesson") {
      const b = await body(req);
      const text = stripNulText(b.text).trim().slice(0, 400);
      const scope = String(b.scope || "global").toLowerCase().slice(0, 40);
      if (!text) return json(res, 400, { error: "text required" });
      if (state.lessons.some(l => l.scope === scope && l.text === text)) return json(res, 200, { ok: true, dedup: true });
      state.lessons.push({ id: state.lessons.length + 1, scope, text, by: b.by || "", ts: now() });
      if (state.lessons.length > 500) state.lessons.splice(0, 100);
      markDirty();
      // Attribute to a PROJECT the same way /send does — never to `scope`, which is lowercased and
      // isn't a project name at all ("global", a topic tag, …). Explicit project wins, then the
      // author's known project, then the "host:project" suffix.
      const lProj = canon(String(b.project || state.peers[b.by]?.project || (b.by && b.by.includes(":") ? b.by.split(":").pop() : "")).slice(0, 80));
      appendEvent("lesson", lProj, b.by || "", { text, scope });
      return json(res, 200, { ok: true, count: state.lessons.length });
    }
    // --- verification gates: structured "must verify before shipping" claims that travel with
    // handoffs and surface PROMINENTLY to whoever takes over (so a safety-critical check can't be
    // skimmed past in narrative prose — the "verify Gail coefficients" intent that got lost). ---
    if (req.method === "POST" && P === "/verify-gate") {
      const b = await body(req); touch(b.by, undefined, b.project, undefined, auth);
      const project = canon(String(b.project || "").slice(0, 80));
      if (b.resolve) {
        const g = state.verifyGates.find(x => x.id === Number(b.id) && x.project === project);
        if (!g) return json(res, 404, { error: "gate not found" });
        g.status = ["verified", "failed", "waived"].includes(b.status) ? b.status : "verified";
        g.resolvedBy = b.by || ""; g.resolvedNote = String(b.note || "").slice(0, 300); g.resolvedTs = now();
        markDirty();
        appendEvent("verify.gate.resolved", project, b.by || "", { gateId: g.id, claim: g.claim, status: g.status, note: g.resolvedNote });
        return json(res, 200, { ok: true, gate: g });
      }
      const claim = String(b.claim || "").trim().slice(0, 300);
      if (!claim) return json(res, 400, { error: "claim required" });
      const dup = state.verifyGates.find(x => x.project === project && x.claim === claim && x.status === "open");
      if (dup) return json(res, 200, { ok: true, gate: dup, dedup: true });
      const g = { id: ++state.verifyGateSeq, project, claim, why: String(b.why || "").slice(0, 300),
        howToVerify: String(b.howToVerify || "").slice(0, 300), status: "open", by: b.by || "", ts: now() };
      state.verifyGates.push(g); if (state.verifyGates.length > 500) state.verifyGates.splice(0, 100);
      markDirty();
      appendEvent("verify.gate.opened", project, b.by || "", { gateId: g.id, claim: g.claim, why: g.why, howToVerify: g.howToVerify });
      return json(res, 200, { ok: true, gate: g });
    }
    if (req.method === "GET" && P === "/verify-gates") {
      const project = canon(String(q.project || ""));
      let gates = filterReadable(auth, state.verifyGates.filter(g => !project || g.project === project), g => g.project || "");
      if (q.all !== "1") gates = gates.filter(g => g.status === "open");
      return json(res, 200, { gates });
    }
    // --- agent-proposed permissions (governance): the autonomy ladder made two-directional ---
    // The operator sets levels top-down (`trantor policy`); this is the bottom-up half — an agent
    // that needs more rope FILES A PROPOSAL instead of assuming, working around, or DM'ing the
    // human free-form. Three rules, all Argus-derived and all enforced HERE, not by convention:
    //   1. A proposal must state its BOUND — scope (what), condition (when), exclusions (what is
    //      still NOT covered). A permission without a bound is a blank cheque, so an unbounded
    //      proposal is a 400, not a pending row.
    //   2. The queue is CAPPED per session (default 3 pending). To file past the cap the agent
    //      must withdraw one of its own — a full queue is a prioritization exercise, not a bug.
    //   3. Denials are REMEMBERED. A near-duplicate of a denied proposal (normalized scope +
    //      condition, same project) is refused with the operator's original note, so "ask again
    //      until the human gives in" is structurally impossible.
    // Deciding is the HUMAN's act alone: /proposal/decide is owner-gated (OWNER_ENDPOINTS) and
    // nothing hub-side ever flips a proposal to approved. Approval grants nothing mechanical
    // today — it is a recorded operator decision the agent may rely on, like a mission note line.
    if (req.method === "POST" && P === "/propose") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      if (!session) return json(res, 400, { error: "session required" });
      if (auth?.identity && String(session) !== String(auth.identity.name || "")) return json(res, 403, { error: "session must match signer" });
      const proj = canon(String(b.project || state.peers[session]?.project || (session.includes(":") ? session.split(":").pop() : "")).slice(0, 80));
      const scope = String(b.scope || "").trim().slice(0, 300);
      const condition = String(b.condition || "").trim().slice(0, 300);
      const exclusions = String(b.exclusions || "").trim().slice(0, 300);
      if (!scope || !condition || !exclusions) {
        return json(res, 400, { error: "a proposal must state its bound: scope (what), condition (when), exclusions (what is still NOT covered) — a permission without a bound is a blank cheque" });
      }
      // optional machine-readable capability key ("patrol.reap-orphans") — lets a TOOL check a
      // grant exactly instead of text-matching prose. Never part of the denial fingerprint.
      const key = String(b.key || "").trim().toLowerCase().slice(0, 60);
      if (key && !/^[a-z0-9][a-z0-9._-]*$/.test(key)) return json(res, 400, { error: "key must be a slug: [a-z0-9._-]" });
      const fp = propFp(scope, condition);
      const denied = state.proposals.find(p => p.status === "denied" && p.project === proj && propFp(p.scope, p.condition) === fp);
      if (denied) {
        return json(res, 409, { error: "near-duplicate of a DENIED proposal — do not re-propose; refine the bound or move on",
          deniedId: denied.id, note: denied.note || "", decidedTs: denied.decidedTs || 0 });
      }
      const pending = state.proposals.filter(p => p.status === "pending" && p.session === session);
      const dup = pending.find(p => p.project === proj && propFp(p.scope, p.condition) === fp);
      if (dup) return json(res, 200, { ok: true, proposal: dup, dedup: true });
      if (pending.length >= PROPOSAL_CAP) {
        return json(res, 409, { error: `queue full: ${pending.length}/${PROPOSAL_CAP} pending for this session — withdraw one of yours to file another`,
          pending: pending.map(p => ({ id: p.id, scope: p.scope })) });
      }
      touch(session, undefined, proj, undefined, auth);
      const pr = { id: ++state.proposalSeq, session, project: proj, scope, condition, exclusions, key,
        status: "pending", ts: now(), decidedTs: 0, decidedBy: "", note: "" };
      state.proposals.push(pr); if (state.proposals.length > 500) state.proposals.splice(0, 100);
      markDirty();
      appendEvent("proposal.filed", proj, session, { proposalId: pr.id, scope, condition, exclusions, ...(key ? { key } : {}) });
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "POST" && P === "/proposal/decide") {
      const b = await body(req);
      const pr = state.proposals.find(p => p.id === Number(b.id));
      if (!pr) return json(res, 404, { error: "no such proposal" });
      // A grant that GATES tool behavior needs an off-switch: the operator may REVOKE an
      // approved proposal. Revocation is not a denial — it leaves no denial memory, so the
      // agent may re-propose a refined bound later.
      if (b.status === "revoked") {
        if (pr.status !== "approved") return json(res, 409, { error: `only an approved proposal can be revoked (is ${pr.status})`, proposal: pr });
      } else if (pr.status !== "pending") return json(res, 409, { error: `already ${pr.status}`, proposal: pr });
      const decision = ["approved", "denied", "revoked"].includes(b.status) ? b.status : "";
      if (!decision) return json(res, 400, { error: "status must be 'approved', 'denied' or 'revoked'" });
      pr.status = decision; pr.decidedTs = now();
      pr.decidedBy = String(auth?.identity?.name || b.by || "").slice(0, 120);
      pr.note = String(b.note || "").slice(0, 300);
      markDirty();
      appendEvent("proposal.decided", pr.project, pr.decidedBy, { proposalId: pr.id, scope: pr.scope, status: decision, note: pr.note });
      // Tell the proposer directly — a decision it never hears about is a decision it will act
      // around. One DM per decision (a transition, never a repeat), hub-authored like escalations.
      hubSend(pr.session,
        `📜 proposal #${pr.id} ${decision.toUpperCase()}${pr.note ? `: ${pr.note}` : ""} — scope was "${pr.scope}". ${decision === "approved" ? "You may rely on it within its stated bound." : decision === "revoked" ? "This grant no longer applies — stop relying on it. You may propose a refined bound." : "Do not re-propose this; refine the bound or move on."}`,
        pr.project);
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "POST" && P === "/proposal/withdraw") {
      const b = await body(req);
      const pr = state.proposals.find(p => p.id === Number(b.id));
      if (!pr) return json(res, 404, { error: "no such proposal" });
      if (pr.status !== "pending") return json(res, 409, { error: `already ${pr.status}`, proposal: pr });
      // own proposals only — a signed request must BE the proposer; unsigned (warn/off) must claim it
      const claimant = String(auth?.identity?.name || b.session || b.by || "").slice(0, 120);
      if (claimant !== pr.session) return json(res, 403, { error: "only the proposing session may withdraw" });
      pr.status = "withdrawn"; pr.decidedTs = now(); pr.decidedBy = pr.session;
      markDirty();
      appendEvent("proposal.withdrawn", pr.project, pr.session, { proposalId: pr.id, scope: pr.scope });
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "GET" && P === "/proposals") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, state.proposals.filter(p =>
        (!proj || p.project === proj) &&
        (!q.status || p.status === q.status) &&
        (!q.session || p.session === q.session)), p => p.project || "").slice(-200);
      const pendingCount = filterReadable(auth, state.proposals.filter(p => p.status === "pending"), p => p.project || "").length;
      return json(res, 200, { proposals: rows, pendingCount });
    }
    // GRANTS = the mechanical face of approvals: the ACTIVE approved proposals, queryable by the
    // tools and sessions that must honor them. Same rows as /proposals?status=approved, but this
    // is the contract surface — a grant listed here may be relied on within its stated bound;
    // revocation removes it here first.
    if (req.method === "GET" && P === "/grants") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, state.proposals.filter(p =>
        p.status === "approved" &&
        (!proj || p.project === proj) &&
        (!q.key || (p.key || "") === String(q.key).toLowerCase()) &&
        (!q.session || p.session === q.session)), p => p.project || "").slice(-200);
      return json(res, 200, { grants: rows.map(p => ({ id: p.id, session: p.session, project: p.project,
        scope: p.scope, condition: p.condition, exclusions: p.exclusions, key: p.key || "",
        decidedBy: p.decidedBy, decidedTs: p.decidedTs, note: p.note || "" })) });
    }
    return false;
}
