/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- SAFETY: Optional message fields must remain absent, not undefined; preserving the existing spread keeps the signed wire shape identical. */
import { setTimeout, setInterval, clearInterval } from "node:timers";

export async function routeMessages({ req, res, q, P, auth, ctx }) {
  const {
    state, body, json, stripNulText, crossProjectGuard, touch, pushToStreams,
    appendEvent, markDelivered, contractsFor, canUseInboxSession, inboxWindow,
    deliverable, inboxReadable, inboxResponse, filterReadable, streams, UI,
    AUTH_MODE, persistHealth, duty, now, markDirty, assertNoSecrets,
    CONTRACT_WINDOW_MS,
  } = ctx;
    if (req.method === "POST" && P === "/send") {
      const b = await body(req);
      const text = stripNulText(b.text);
      if (!b.from || !text.trim()) return json(res, 400, { error: "from and non-empty text required" });
      const secretCheck = assertNoSecrets(text);
      if (!secretCheck.ok) return json(res, 400, { error: "secret detected", kinds: secretCheck.kinds || [] });
      if (auth?.identity && String(b.from) !== String(auth.identity.name || "")) return json(res, 403, { error: "from must match signer" });
      const cpg = crossProjectGuard(auth, P, b);
      if (!cpg.ok) return json(res, cpg.code, { error: cpg.error });
      touch(b.from, undefined, undefined, undefined, auth);
      // attribute the message to a project so the dashboard can show it in that project's lane.
      // explicit b.project wins; else the sender's known project; else parsed from a "host:project" id.
      const fromProj = state.peers[b.from]?.project || (b.from && b.from.includes(":") ? b.from.split(":").pop() : "");
      // `re` threads an OUTCOME back to the CONTRACT it answers. Without it "what am I still owed"
      // is guesswork: a seat still working and a seat that died look identical from the sender's
      // side, which is how an orchestrator ends up waiting forever on a dead peer.
      const re = Number.isFinite(Number(b.re)) && Number(b.re) > 0 ? Number(b.re) : 0;
      const kind = String(b.kind || "").slice(0, 40);
      // `wake:false` is the SENDER saying this message is context, not a contract: the receiving
      // runner batches it into that seat's next turn instead of spending a whole CLI session on
      // it (#6134). Stored only when false — absent means wake, so every older client is unchanged.
      const wake = b.wake === false ? { wake: false } : {};
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text, project: String(b.project || fromProj || "").slice(0, 80), ...(re ? { re } : {}), ...(kind ? { kind } : {}), ...wake };
      state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
      markDirty(); pushToStreams(msg);               // <-- instant push to live watchers
      // Mirror onto the unified log. `refs` = the card ids this message cites (#3701), which is what
      // lets the FEED thread a conversation under the card it's about. Deliberately NOT `taskId`:
      // that field is the card-event key, and /card must keep counting card events only.
      const refs = [...new Set((msg.text.match(/#(\d{1,7})(?![0-9])/g) || []).map(s => Number(s.slice(1))))].slice(0, 8);
      appendEvent("message", msg.project, msg.from, { msgId: msg.id, toSession: msg.to, text: msg.text.slice(0, 2000), refs });
      return json(res, 200, { ok: true, id: msg.id });
    }
    // ---- /contracts: what this session dispatched and has not been answered on ----------------
    // A contract is a DIRECT message from you to one peer. It closes when that peer sends you an
    // outcome: strictly by `re`, or, for seats that predate it, oldest-open-first. Broadcasts are
    // never contracts. Each open one carries the assignee's presence, because the actionable half
    // of "still waiting" is whether anyone is still on the other end.
    // ---- /delivered: an endpoint that has actually READ its mail says so ----------------------
    // The desktop app lists with peek=1 on purpose, so it never steals a message from a session's
    // delivery hooks. For a HUMAN endpoint there are no hooks — the app is the only reader — so
    // sasha@mac's deliveredUpTo sat at 0 forever while mail piled up. dutyTick then escalated every
    // message the human had already read, told the duty seat about it, the seat messaged the human,
    // and that was undelivered too: about six escalations a minute, all about mail already read.
    // Peeking stays the default; this lets a reader record delivery explicitly instead.
    if (req.method === "POST" && P === "/delivered") {
      const b = await body(req);
      const session = String(b.session || "");
      if (!session) return json(res, 400, { error: "session required" });
      if (auth?.identity && String(auth.identity.name || "") !== session) {
        return json(res, 403, { error: "session must match signer" });
      }
      touch(session, undefined, undefined, undefined, auth);
      markDelivered(session, Number(b.upTo || 0));
      return json(res, 200, { ok: true, deliveredUpTo: state.peers[session]?.deliveredUpTo || 0 });
    }

    if (req.method === "GET" && P === "/contracts") {
      const session = String(q.session || "");
      if (!session) return json(res, 400, { error: "session required" });
      const windowMs = Math.max(60000, Number(q.windowMs || CONTRACT_WINDOW_MS));
      const rawOverdue = q.overdueMs === undefined || q.overdueMs === "" ? null : Number(q.overdueMs);
      const overdueMs = Number.isFinite(rawOverdue) ? Math.max(0, rawOverdue) : null;
      const all = contractsFor(session, { project: String(q.project || ""), windowMs, overdueMs });
      const by = (d) => all.filter(c => c.disposition === d).length;
      // Abandoned contracts leave `contracts` entirely and ride in their own key.
      //
      // Not cosmetic. A session's hooks are PINNED at session start, so an older stop hook iterates
      // `contracts` with its own predicate and knows nothing about `disposition` — it kept blocking on
      // ghosts no matter what the hub called them. Keeping them in the array meant the fix only
      // reached sessions that restarted, and a live one nagged its operator every single turn.
      // Splitting them out fixes every running session the moment the hub redeploys, and the ledger
      // still shows what died via `abandonedContracts`.
      // `superseded` leaves `contracts` for exactly the reason `abandoned` does: a session's hooks
      // are PINNED at session start, so an older stop hook filters this array with its own
      // predicate and would keep blocking on a row the hub has already settled.
      const out = all.filter(c => c.disposition !== "abandoned" && c.disposition !== "superseded");
      return json(res, 200, {
        session, contracts: out, abandonedContracts: all.filter(c => c.disposition === "abandoned"),
        supersededContracts: all.filter(c => c.disposition === "superseded"),
        open: out.filter(c => !c.answered).length,
        waiting: by("waiting"), stalled: by("stalled"), abandoned: by("abandoned"),
        superseded: by("superseded"), answered: by("answered"),
      });
    }

    if (req.method === "GET" && P === "/inbox") {
      if (!canUseInboxSession(auth, q.session)) return json(res, 403, { error: "forbidden" });
      touch(q.session, undefined, undefined, undefined, auth); const window = inboxWindow(q.since);
      const { since, rewound } = window;
      const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session) && inboxReadable(auth, m, q.session));
      const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
      // peek=1 -> LOOK without claiming delivery. The Stop hook has to ask "is anything waiting?" before
      // it knows whether it will surface it (it may be on its second pass, where it must let the stop
      // through). Advancing the ledger on a peek would tell the deferred waker the message had been
      // delivered when nobody ever saw it — a silent hole exactly where this feature is supposed to help.
      if (q.peek !== "1") markDelivered(q.session, cursor);
      // superseded (instance-keys contract): a baton twin that lost the claim learns it HERE, via
      // its own read — its hooks turn this into a stand-down note for the model. Never a block.
      return json(res, 200, inboxResponse(auth, msgs, cursor, rewound));
    }
    if (req.method === "GET" && P === "/poll") {
      if (!canUseInboxSession(auth, q.session)) return json(res, 403, { error: "forbidden" });
      touch(q.session, undefined, undefined, undefined, auth); const window = inboxWindow(q.since);
      const { since, rewound } = window;
      if (rewound) {
        markDelivered(q.session, window.tip);
        return json(res, 200, inboxResponse(auth, [], window.tip, true));
      }
      const waitMs = Math.min(Number(q.wait || 25), 290) * 1000;   // allow long idle-park
      const deadline = now() + waitMs;
      let settled = false;
      const tick = () => {
        if (settled || res.headersSent || res.writableEnded || res.destroyed) {
          settled = true;
          return;
        }
        const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session) && inboxReadable(auth, m, q.session));
        if (msgs.length || now() >= deadline) { settled = true; touch(q.session, undefined, undefined, undefined, auth); const cursor = msgs.length ? msgs[msgs.length - 1].id : since; markDelivered(q.session, cursor); return json(res, 200, inboxResponse(auth, msgs, cursor)); }
        setTimeout(tick, 300);
      };
      tick();
      return true;
    }
    if (req.method === "GET" && P === "/stream") {                 // SSE — true push, no polling
      const session = q.session || "all";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" });
      res.write(`: connected as ${session}\n\n`);
      touch(session, q.status, undefined, undefined, auth);
      // events=1 opts this stream into the unified log as NAMED "ev" frames (see pushEventToStreams).
      // Existing consumers omit it and keep receiving bus messages on the default channel only.
      const entry = { session, res, events: q.events === "1" };
      streams.push(entry);
      const ka = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        try { res.write(": ka\n\n"); touch(session, undefined, undefined, undefined, auth); } catch {}
      }, 20000);
      req.on("close", () => { clearInterval(ka); const i = streams.indexOf(entry); if (i >= 0) streams.splice(i, 1); });
      return true;
    }
    if (req.method === "GET" && P === "/recent") {   // god-view: last N messages, for the dashboard feed
      const n = Math.min(Number(q.limit || 50), 200);
      return json(res, 200, { messages: filterReadable(auth, state.messages, m => m.project || "").slice(-n) });
    }
    if (req.method === "GET" && (P === "/" || P === "/ui")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(UI || "<h1>trantor</h1><p>dashboard unavailable</p>");
    }
    if (P === "/health") return json(res, 200, { ok: true, authMode: AUTH_MODE, peers: Object.keys(state.peers).length, messages: state.messages.length, streams: streams.length,
      persist: persistHealth.view(),
      // #5686: duty liveness rides /health so the app's Home strip and doctor read one truth.
      duty: { ...duty.dutyLiveness(), darkSinceMs: duty.darkSince ? now() - duty.darkSince : 0, queuedEscalations: duty.dutyQueuedEscalations() } });
    return false;
}
