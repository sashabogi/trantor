/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: These checks preserve the established request and provider-response compatibility boundary during a route-only extraction. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function routeAdmin({ req, res, q, P, auth, ctx }) {
  const {
    state, body, json, crossProjectGuard, touch, canon, filterReadable,
    appendEvent, EVENT_CAP, overseer, ONLINE_MS, pruneClaims, fileClaims,
    scopeAllows, duty, markDirty, HUB_VERSION, cmpSemver, prunePeers,
    filterDiscoverable, healthOf, now, canRead, AUTH_MODE, CLAIM_TTL_MS, subFp,
  } = ctx;
  const { overseerPolicy, overseerInputs, declaredCrewFor } = overseer;
    if (req.method === "POST" && P === "/register") {
      const b = await body(req);
      const cpg = crossProjectGuard(auth, P, b);
      if (!cpg.ok) return json(res, cpg.code, { error: cpg.error });
      touch(b.session, b.status, b.project, b.hookVersion, auth);
      // WHO is this, really: the LLM brand + the exact model currently loaded. In-memory like the
      // rest of presence — the next heartbeat re-supplies it after a restart.
      const pr = state.peers[b.session];
      // #6148: WHAT a session is rides its peer row (kind "genesis" = the CLI's brief-poster,
      // "agent" = a crew seat) — /peers hands it to the app so the seat strip can tell them apart.
      if (pr) { if (b.model) pr.model = String(b.model).slice(0, 80); if (b.llm) pr.llm = String(b.llm).slice(0, 40); if (b.kind) pr.kind = String(b.kind).slice(0, 40); }
      return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) });
    }
    if (req.method === "POST" && P === "/status") { const b = await body(req); touch(b.session, b.status ?? "", b.project, b.hookVersion, auth); return json(res, 200, { ok: true }); }
    // Single-peer lookup, including the read receipt (how far this session's inbox has actually been
    // handed over). Kept out of /peers, which feeds the dashboard and wants presence, not delivery state.
    // Does NOT touch(), so asking about a peer can never make it look alive.
    if (req.method === "GET" && P === "/peer") {
      const p = state.peers[q.session];
      if (!p) return json(res, 404, { error: "unknown peer" });
      if (!canRead(auth, p.project || "")) return json(res, 404, { error: "unknown peer" });
      return json(res, 200, { session: q.session, project: p.project || "", lastSeen: p.lastSeen || 0,
        online: p._on === true, deliveredUpTo: p.deliveredUpTo || 0 });
    }
    // --- Handoff storm guard (server-side, version-independent) ---
    // A session running OLD hooks (before the local markHandedOff guard) re-fires a handoff every few
    // minutes — the crebral-cortex storm: 9 handoffs in 49 min, each spawning a Terminal window. The hub
    // rate-limits per (project, session): a fresh handoff within the cooldown is refused, so an updated
    // client DEFERS the spawn. Manual handoffs (force:true) always pass. GET /handoffs exposes the log.
    if (req.method === "POST" && P === "/handoff") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      const session = String(b.session || "").slice(0, 120);
      if (!proj || !session) return json(res, 400, { error: "project and session required" });
      const cooldownMs = (Number(b.cooldownSec) > 0 ? Number(b.cooldownSec) : 300) * 1000;
      const ts = now();
      const recent = state.handoffLog.filter(h => h.project === proj && h.session === session && (ts - h.ts) < cooldownMs);
      if (!b.force && recent.length) {
        const last = recent[recent.length - 1];
        return json(res, 200, { ok: true, allow: false, reason: "storm-guard", lastTs: last.ts, sinceSec: Math.round((ts - last.ts) / 1000), cooldownSec: cooldownMs / 1000 });
      }
      state.handoffLog.push({ project: proj, session, ts, trigger: String(b.trigger || "").slice(0, 20), id: String(b.id || "").slice(0, 80), forced: !!b.force });
      if (state.handoffLog.length > 500) state.handoffLog.splice(0, state.handoffLog.length - 500);
      markDirty();
      appendEvent("handoff.written", proj, session, { handoffId: String(b.id || "").slice(0, 80), trigger: String(b.trigger || "").slice(0, 20), forced: !!b.force });
      return json(res, 200, { ok: true, allow: true });
    }
    if (req.method === "GET" && P === "/handoffs") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const lim = Math.min(200, Number(q.limit) || 50);
      const rows = filterReadable(auth, state.handoffLog.filter(h => !proj || h.project === proj), h => h.project).slice(-lim).reverse();
      return json(res, 200, { handoffs: rows });
    }
    // --- file claims: shared-resource awareness (the "two sessions, one file" problem) ----------
    // A claim says "this session touched this file moments ago". The PreToolUse hook posts one
    // BEFORE every file edit, and the response carries any live claims by OTHER sessions — which
    // the hook hands to the acting session's own model, so an orchestrator learns about a
    // collision before the edit lands, not at git time. Ephemeral BY DESIGN: like presence, a
    // claim describes NOW, and a restart forgetting it is correct, so nothing touches the store.
    // --- project adoption: merge one project's rows brought from ANOTHER hub -------------------
    // The other half of `trantor adopt`: the CLI reads the project's data off the machine-local
    // hub and POSTs it here (owner-signed), so onboarding needs no ssh and no direct Postgres
    // access. Colliding card ids get FRESH ids (both hubs mint from their own taskSeq — the
    // split-brain lesson from the first migration), and their events are re-pointed. Events append
    // with new log ids; messages take the next seq. Idempotence is the CALLER's contract: adopt
    // refuses to run when the project already has cards here, unless forced.
    if (req.method === "POST" && P === "/import") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      if (!proj) return json(res, 400, { error: "project required" });
      const existing = state.tasks.filter(t => t.project === proj).length;
      if (existing && !b.force) return json(res, 409, { error: "project already has cards here", existing });
      const remap = new Map();
      const added = { tasks: 0, events: 0, messages: 0, remapped: 0 };
      const have = new Set(state.tasks.map(t => t.id));
      for (const t of (Array.isArray(b.tasks) ? b.tasks : [])) {
        let id = Number(t.id);
        if (!Number.isFinite(id)) continue;
        if (have.has(id)) { const nid = ++state.taskSeq; remap.set(id, nid); id = nid; added.remapped++; }
        else state.taskSeq = Math.max(state.taskSeq, id);
        state.tasks.push({ ...t, id, project: proj });
        have.add(id); added.tasks++;
      }
      for (const e of (Array.isArray(b.events) ? b.events : [])) {
        const last = state.events[state.events.length - 1];
        // Spread the incoming event FIRST, then stamp OUR id and project over it. The incoming `id`
        // belongs to the other hub's log and must not survive in any form: carried into the payload
        // it comes back on load and overwrites the real row id.
        state.eventSeq = Math.max(Number(state.eventSeq || 0), Number(last?.id) || 0) + 1;
        const ev = { ...e, id: state.eventSeq, project: proj };
        if (ev.taskId != null && remap.has(Number(ev.taskId))) ev.taskId = remap.get(Number(ev.taskId));
        state.events.push(ev); added.events++;
      }
      if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP);
      for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
        state.messages.push({ ...m, id: ++state.seq, project: proj }); added.messages++;
      }
      if (state.messages.length > 5000) state.messages.splice(0, 1000);
      markDirty();
      appendEvent("project.adopted", proj, String(b.by || ""), { counts: added });
      return json(res, 200, { ok: true, ...added });
    }
    if (req.method === "GET" && P === "/policy") {
      return json(res, 200, overseerPolicy());
    }
    if (req.method === "POST" && P === "/policy") {
      const b = await body(req);
      const p = state.orgPolicy && typeof state.orgPolicy === "object" ? state.orgPolicy : {};
      p.autonomy = { ...(p.autonomy || {}) };
      p.links = Array.isArray(p.links) ? p.links : [];
      if (b.autonomy && typeof b.autonomy === "object") {
        for (const [proj, lvl] of Object.entries(b.autonomy)) {
          const n = Number(lvl);
          if ([1, 2, 3, 4].includes(n)) p.autonomy[canon(String(proj).slice(0, 80))] = n;
        }
      }
      if (b.link && Array.isArray(b.link.projects) && b.link.projects.length >= 2 && b.link.reason) {
        const projects = b.link.projects.slice(0, 4).map(x => canon(String(x).slice(0, 80))).sort();
        const key = projects.join(" ");
        if (!p.links.some(l => (l.projects || []).slice().sort().join(" ") === key)) {
          p.links.push({ projects, reason: String(b.link.reason).slice(0, 140),
            declaredBy: auth?.identity?.name || String(b.by || ""), ts: now() });
        }
      }
      // Unlink is link's inverse (#5397 shipped the app's Unlink button before this existed —
      // a declared codependency the operator can make, they must also be able to unmake).
      if (b.unlink && Array.isArray(b.unlink.projects) && b.unlink.projects.length >= 2) {
        const key = b.unlink.projects.slice(0, 4).map(x => canon(String(x).slice(0, 80))).sort().join(" ");
        p.links = (p.links || []).filter(l => (l.projects || []).slice().sort().join(" ") !== key);
      }
      state.orgPolicy = p; markDirty();
      return json(res, 200, { ok: true, ...overseerPolicy() });
    }
    // What a session arriving on <project> needs to know: its autonomy level, who else is live,
    // which files are in flight, which projects are declared codependent, current collisions.
    if (req.method === "GET" && P === "/overseer/status") {
      // The Overseer view's backbone: is the watcher ALIVE, and what is it watching right now.
      // `warnings` is the LIVE detection result from the last tick (pre-dedup), not the event log —
      // the log answers "what did it do", this answers "what does it see".
      const pol = overseerPolicy();
      const cutoff = now() - ONLINE_MS;
      const livePeers = Object.entries(state.peers).filter(([, v]) => v.lastSeen > cutoff);
      pruneClaims();
      return json(res, 200, {
        engine: !!overseer.engine?.detectCollisions,
        lastTickTs: overseer.lastTick,
        tickMs: overseer.OVERSEER_TICK_MS,
        clearMs: overseer.OVERSEER_CLEAR_MS,
        dutySession: duty.session || "",
        watching: {
          sessions: livePeers.length,
          projects: new Set(livePeers.map(([, v]) => v.project).filter(Boolean)).size,
          claims: fileClaims.size,
          links: pol.links.length,
        },
        autonomy: pol.autonomy,
        links: pol.links,
        // `since` turns a detection into a duration — "standing 4h" reads very differently from
        // "just started", and that distinction is the whole point of episode-based warning.
        warnings: overseer.lastCollisions.map(c => ({ ...c, since: c.since || 0 })),
        standing: overseer.active.size,
      });
    }
    if (req.method === "GET" && P === "/overseer/context") {
      const proj = canon(String(q.project || "").slice(0, 80));
      if (!proj) return json(res, 400, { error: "project required" });
      const pol = overseerPolicy();
      const level = overseer.engine?.levelFor ? overseer.engine.levelFor(proj, pol.autonomy) : (pol.autonomy[proj] ?? pol.autonomy["*"] ?? 1);
      const links = pol.links.filter(l => (l.projects || []).includes(proj));
      const linked = new Set(links.flatMap(l => l.projects).filter(x => x !== proj));
      const cutoff = now() - ONLINE_MS;
      const peersOut = Object.entries(state.peers)
        .filter(([, v]) => v.lastSeen > cutoff && (v.project === proj || linked.has(v.project)))
        .map(([session, v]) => ({ session, project: v.project || "", llm: v.llm || "", model: v.model || "", status: v.status || "" }));
      pruneClaims();
      const inflight = [...fileClaims.values()].filter(c => c.project === proj)
        .map(c => ({ file: c.file, session: c.session, agoSec: Math.round((now() - c.ts) / 1000) }));
      let warnings = [];
      try {
        warnings = (overseer.engine?.detectCollisions ? overseer.engine.detectCollisions(overseerInputs()) : [])
          .filter(c => c.project === proj || linked.has(c.project));
        // #5760: a declared crew is the NORMAL state of a project, not a collision — the tick
        // loop drops crew-only sets before they ever become episodes, and this live view must
        // agree with it: the SessionStart hook narrates exactly these lines, so a crew-only leak
        // here would re-wake every booting seat into a metered turn for no membership change.
        warnings = warnings.filter(c => !(c.kind === "same-project-sessions" && overseer.sameProject?.sameProjectDecision &&
          overseer.sameProject.sameProjectDecision({
            current: c.sessions,
            declaredCrew: declaredCrewFor(c.project),
            now: now(),
          }).reason === "crew-only"));
        // The record line reports DURATION ("same-project for 6h"), never a count of warnings.
        for (const c of warnings) {
          if (c.kind !== "same-project-sessions") continue;
          const ep = overseer.active.get(`${c.project} same-project-sessions`);
          if (ep) {
            c.since = ep.since;
            if (overseer.sameProject?.durationLabel) c.detail = `${c.detail || ""} (same-project for ${overseer.sameProject.durationLabel(now() - ep.since)})`.trim();
          }
        }
      } catch {}
      return json(res, 200, { level, links: links.map(l => ({ projects: l.projects, reason: l.reason })), peers: peersOut, inflight, warnings });
    }
    // Supersession (docs/INSTANCE-KEYS-CONTRACT.md): EXPLICIT, never automatic — the baton-claim
    // path calls this when a fresh session consumes a handoff. Marks every OTHER instance of the
    // named durable identity superseded; their /inbox + /poll answers then carry superseded:true so
    // their own hooks tell the model to stand down. Informational, never a hard block. Accepted
    // only from an endorsed instance of the SAME durable identity, or the owner.
    if (req.method === "POST" && P === "/instance/supersede") {
      const b = await body(req);
      const name = String(b.name || "").slice(0, 200);
      const except = String(b.exceptInstanceId || "").slice(0, 200);
      if (!name) return json(res, 400, { error: "name required" });
      if (AUTH_MODE !== "off") {
        const sameIdentity = auth?.identity && String(auth.identity.name || "") === name;
        const isOwner = auth?.identity?.kind === "human" || scopeAllows(auth?.identity, "", "owner");
        if (!sameIdentity && !isOwner && AUTH_MODE === "enforce") return json(res, 403, { error: "forbidden" });
      }
      let flipped = 0;
      for (const rec of Object.values(state.instances || {})) {
        if (rec.name !== name || rec.superseded) continue;
        if (except && rec.instanceId === except) continue;
        rec.superseded = now(); rec.supersededBy = except || ""; flipped++;
      }
      if (flipped) markDirty();
      return json(res, 200, { ok: true, superseded: flipped });
    }
    if (req.method === "POST" && P === "/overseer/duty") {
      const b = await body(req);
      if (b.session === undefined) return json(res, 400, { error: "session required (send \"\" to clear the duty seat)" });
      const session = String(b.session).slice(0, 120);
      duty.setSession(session);
      return json(res, 200, { ok: true, dutySession: duty.session });
    }
    if (req.method === "POST" && P === "/overseer/narrate") {
      const b = await body(req);
      const ev = state.events.find(e => e.id === Number(b.eventId) && e.type === "overseer.warn");
      if (!ev) return json(res, 404, { error: "no such overseer.warn event" });
      ev.narrated = true; ev.narration = String(b.text || "").slice(0, 300);
      markDirty();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && P === "/claim") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      const file = String(b.file || "").slice(0, 400);
      const session = String(b.session || "").slice(0, 120);
      if (!proj || !file || !session) return json(res, 400, { error: "project, file and session required" });
      pruneClaims();
      const key = `${proj} ${file} ${session}`;
      const mine = fileClaims.get(key);
      const conflicts = [...fileClaims.values()]
        .filter(c => c.project === proj && c.file === file && c.session !== session)
        .map(c => ({ session: c.session, ts: c.ts, agoSec: Math.round((now() - c.ts) / 1000) }));
      fileClaims.set(key, { project: proj, file, session, ts: now() });
      touch(session, undefined, undefined, undefined, auth);
      // Feed events, throttled by design: the FIRST touch inside a TTL window says "claimed";
      // a collision says so every time — that is the one worth seeing on the FEED.
      if (!mine) appendEvent("file.claim", proj, session, { file });
      if (conflicts.length) appendEvent("file.conflict", proj, session, { file, with: conflicts.map(c => c.session) });
      return json(res, 200, { ok: true, conflicts, ttlMs: CLAIM_TTL_MS });
    }
    if (req.method === "GET" && P === "/claims") {
      pruneClaims();
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, [...fileClaims.values()].filter(c => !proj || c.project === proj), c => c.project)
        .map(c => ({ ...c, agoSec: Math.round((now() - c.ts) / 1000) }))
        .sort((a, b) => b.ts - a.ts);
      return json(res, 200, { claims: rows });
    }
    if (req.method === "GET" && P === "/peers") {
      prunePeers();
      const cutoff = now() - ONLINE_MS;
      const peerRows = filterDiscoverable(auth, Object.entries(state.peers), ([, v]) => v.project || "");
      return json(res, 200, { hubVersion: HUB_VERSION, authMode: AUTH_MODE, peers: peerRows.map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status), project: v.project || "",
        pubkey: v.pubkey || "", identity: v.identity || null, authWarning: v.authWarning || "",
        kind: v.kind || v.identity?.kind || "", llm: v.llm || "", model: v.model || "", hookVersion: v.hookVersion || "", staleHooks: !!(v.lastSeen > cutoff && v.hookVersion && HUB_VERSION && cmpSemver(v.hookVersion, HUB_VERSION) < 0) })) });
    }
    // --- Provider balances (prepaid credit) ---
    // The hub runs under launchd with no provider keys, so it can't fetch balances itself. Env-having
    // clients (the `trantor balances` CLI, the SessionStart hook) fetch + POST a snapshot here; the hub
    // just caches the last-known snapshot and serves it to the dashboard. Latest writer wins.
    if (req.method === "POST" && P === "/balances") {
      const b = await body(req);
      const entries = Array.isArray(b.balances) ? b.balances.slice(0, 30) : [];
      const ts = (Number.isFinite(b.ts) && b.ts > 0) ? Math.floor(b.ts) : now();
      // only accept a newer snapshot (avoid an older session clobbering a fresh push)
      if (ts >= (state.balances?.ts || 0)) { state.balances = { ts, by: String(b.by || "").slice(0, 120), entries }; markDirty(); }
      return json(res, 200, { ok: true });
    }
    // USAGE v2: the Claude statusline sidechannel. Claude Code >=2.1.80 pipes rate_limits into
    // the statusLine command on every turn; hooks/statusline.mjs forwards it here (floored 15s
    // client-side). The live windows PATCH the cached balances snapshot — free usage between
    // `trantor balances` runs, and the poller can skip Claude while liveTs is fresh (Orca's
    // lesson, docs/RESEARCH-orca-usage.md §1.1: the OAuth endpoint 429s under polling).
    if (req.method === "POST" && P === "/usage/claude") {
      const b = await body(req);
      const win = (w, name) => (w && (w.used_percentage ?? w.utilization) != null)
        ? { name, usedPct: Math.round(Number(w.used_percentage ?? w.utilization)), resetsAt: w.resets_at ?? null } : null;
      const wins = [["fiveHour", "5h"], ["sevenDay", "7d"], ["fable", "Fable"]]
        .map(([k, n]) => win(b[k], n)).filter(Boolean);
      if (!wins.length) return json(res, 400, { error: "no usable windows" });
      state.balances ||= { ts: 0, by: "", entries: [] };
      let e = state.balances.entries.find(x => x.provider === "claude");
      if (!e) { e = { provider: "claude", label: "Claude", kind: "windows", ok: true, windows: [] }; state.balances.entries.push(e); }
      // Same-value posts inside 30s are dropped (the statusline ticks ~3x/sec while streaming).
      const sig = JSON.stringify(wins);
      if (e._liveSig === sig && now() - (e.liveTs || 0) < 30_000) return json(res, 200, { ok: true, deduped: true });
      for (const w of wins) { const cur = (e.windows ||= []).find(x => x.name === w.name); if (cur) Object.assign(cur, w); else e.windows.push(w); }
      e.ok = true; e.liveTs = now(); e._liveSig = sig; e.liveSource = "statusline";
      markDirty();
      return json(res, 200, { ok: true, windows: wins.length });
    }
    if (req.method === "GET" && P === "/balances") {
      let cfg = {}; try { cfg = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); } catch {}
      const low = { USD: 5, CNY: 35, EUR: 5, ...(cfg.lowBalance || {}) };
      const lowQuotaPct = typeof cfg.lowQuotaPct === "number" ? cfg.lowQuotaPct : 15;
      const lowOf = e => !e.ok ? false : (e.kind === "quota"
        ? (e.remainingPct != null && e.remainingPct < lowQuotaPct)
        : (e.remaining != null && e.remaining < (low[e.currency] ?? low.USD ?? 5)));
      const ALIAS = { kimi: "moonshot", moonshot: "moonshot", glm: "zhipu", zai: "zhipu", zhipu: "zhipu" };
      const canonP = p => ALIAS[p] || p;
      let prof = {}; try { prof = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "profile.json"), "utf8")).providers || {}; } catch {}
      const profByCanon = {}; for (const [p, v] of Object.entries(prof)) profByCanon[canonP(p)] = v;
      const detectedCli = new Set(["claude", "codex"]);
      // API-key rows remain profile-scoped so a stray ambient key never appears. Claude and Codex
      // instead arrive only after the client registry detects their binary, auth artifact and probe;
      // a missing quota declaration must not hide those machine-login rows from the bottom bar.
      // a prepaid entry that ERRORED but whose provider is a subscription per profile is really a
      // subscription (some plan keys have no balance endpoint → the 401 is expected, not a problem).
      const isSub = (t) => !!t && t !== "api";   // capped-sub / high-sub → a subscription (nothing to refill)
      const entries = (state.balances?.entries || []).filter(e => detectedCli.has(e.provider) || profByCanon[canonP(e.provider)]).map(e => {
        const pv = profByCanon[canonP(e.provider)];
        if (!e.ok && isSub(pv?.tier)) return { provider: e.provider, label: e.label, kind: "subscription", plan: pv.plan, ok: true, remaining: null, low: false };
        return { ...e, low: lowOf(e) };
      });
      // List configured non-CLI subscriptions not already fetched. Claude/Codex may only come from
      // live registry detection above; a stale profile declaration cannot manufacture either row.
      const known = new Set(entries.map(e => canonP(e.provider)));
      const subs = Object.entries(prof)
        .filter(([p, v]) => !detectedCli.has(p) && isSub(v?.tier) && !known.has(canonP(p)))
        .map(([p, v]) => ({ provider: p, label: p, kind: "subscription", plan: v.plan, ok: true, remaining: null, low: false }));
      return json(res, 200, { ts: state.balances?.ts || 0, by: state.balances?.by || "", thresholds: low,
        entries: [...entries, ...subs], lowCount: entries.filter(e => e.low).length, stale: (now() - (state.balances?.ts || 0)) > 6 * 3600e3 });
    }
    // Rebuild cc-subagent notional cards for a project from recomputed on-disk transcript costs
    // (`trantor recost`). REPLACES the project's existing cc-subagent cards with the supplied set so the
    // dashboard reflects the real, recoverable notional instead of stale/contaminated values. Each entry
    // is guarded again server-side (implausible → null) so a bad client can't reintroduce inflation.
    if (req.method === "POST" && P === "/subagent-recost") {
      const b = await body(req);
      const incoming = Array.isArray(b.entries) ? b.entries : [];
      // Group by CANONICAL project (so alias lanes — builtbetter→builtbetter.ai, horvath-research→
      // crebral-health — merge instead of clobbering), then by fingerprint within each lane. All in ONE
      // request so the per-lane replace is atomic. Each entry's bad cost is guarded out (counted, not billed).
      const byProj = new Map();
      for (const e of incoming) {
        const proj = canon(String(e.project || "").slice(0, 80)); if (!proj) continue;
        const title = String(e.title || "").slice(0, 200); if (!title) continue;
        if (!byProj.has(proj)) byProj.set(proj, new Map());
        const fpMap = byProj.get(proj); const fp = subFp(title);
        let g = fpMap.get(fp);
        if (!g) { g = { title, costUsd: 0, anyUsd: false, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, count: 0, model: "", ts: 0 }; fpMap.set(fp, g); }
        // guard PER-INVOCATION (entries are rolling sums; a legit 100-invocation card can exceed $50)
        const n = Math.max(1, Number(e.count) || 1);
        const cr = (e.tokens && typeof e.tokens === "object") ? Number(e.tokens.cacheRead) || 0 : 0;
        const implausible = (cr / n) > 50e6 || (typeof e.costUsd === "number" && (e.costUsd / n) > 50);
        g.count += n;
        const ets = Number(e.ts) || 0; if (ets > g.ts) g.ts = ets;
        if (!g.model && e.model) g.model = String(e.model).slice(0, 60);
        if (!implausible) {
          if (typeof e.costUsd === "number") { g.costUsd += e.costUsd; g.anyUsd = true; }
          if (e.tokens && typeof e.tokens === "object") { g.tokens.input += Number(e.tokens.input) || 0; g.tokens.output += Number(e.tokens.output) || 0; g.tokens.cacheWrite += Number(e.tokens.cacheWrite) || 0; g.tokens.cacheRead += Number(e.tokens.cacheRead) || 0; }
        }
      }
      let removedTotal = 0, addedTotal = 0; const results = [];
      for (const [proj, fpMap] of byProj) {
        // only reseed a lane that already exists on the board — never mint a lane for a stray cwd
        const known = state.tasks.some(t => t.project === proj) || !!state.projectMeta?.[proj] || Object.values(state.peers || {}).some(p => p.project === proj);
        if (!known) { results.push({ project: proj, skipped: "unknown-project" }); continue; }
        const removedIds = new Set(state.tasks.filter(t => t.source === "cc-subagent" && t.project === proj).map(t => t.id));
        state.tasks = state.tasks.filter(t => !removedIds.has(t.id));
        if (Array.isArray(state.events)) state.events = state.events.filter(e => !removedIds.has(e.taskId));
        let added = 0, usd = 0;
        for (const [fp, g] of fpMap) {
          const ts0 = (Number.isFinite(g.ts) && g.ts > 0 && g.ts <= now() + 864e5) ? Math.floor(g.ts) : now();
          const t = { id: ++state.taskSeq, project: proj, title: g.title, assignee: `subagent:${proj}`, status: "done",
            phase: "sub-agents", source: "cc-subagent", costKind: "subagent-notional",
            costUsd: g.anyUsd ? +g.costUsd.toFixed(6) : null, costNote: "recomputed from on-disk transcript",
            model: g.model || "", effort: "", tokens: g.anyUsd ? g.tokens : null, difficulty: "", deps: [],
            by: `recost:${proj}`, ts: ts0, updated: ts0, count: g.count, _fp: fp,
            history: [{ to: "done", by: "recost", ts: ts0 }] };
          state.tasks.push(t); added++; usd += g.anyUsd ? g.costUsd : 0;
        }
        removedTotal += removedIds.size; addedTotal += added;
        results.push({ project: proj, removed: removedIds.size, added, usd: +usd.toFixed(2) });
      }
      markDirty();
      return json(res, 200, { ok: true, removed: removedTotal, added: addedTotal, projects: results });
    }
    return false;
}
    // --- Kanban tasks ---
