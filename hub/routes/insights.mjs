/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Ledger and card records are historical external formats; their compatibility probes remain unchanged in this structural split. */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let ledgerCache = { mtimeMs: -1, rows: [] };
const TURN_OUTCOMES = new Set(["completed", "asked", "blocked", "no-delivery", "empty", "stalled", "cut", "rejected", "api-error"]);
const stringWithin = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const safeInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const optionalBoolean = (row, key) => row[key] === undefined || typeof row[key] === "boolean";

function validTurnRow(row, nowMs) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if ("prompt" in row || "output" in row || "text" in row) return null;
  if (typeof row.id !== "string" || !/^[0-9a-f]{32}$/i.test(row.id) || row.v !== 1) return null;
  if (!safeInteger(row.ts, 1) || row.ts > nowMs + 60000 || !safeInteger(row.turn, 1)) return null;
  if (!stringWithin(row.persona, 120) || !stringWithin(row.agent, 80) || !stringWithin(row.project, 80)) return null;
  // A machine with no label configured reports "" (lib/machine-label.mjs): that is a valid row, not a dropped one.
  if (typeof row.machine !== "string" || row.machine.length > 120) return null;
  if (!stringWithin(row.trigger, 120) || !stringWithin(row.model, 200)) return null;
  if (!safeInteger(row.card) || !safeInteger(row.duration_ms)) return null;
  if (!(row.tokens === null || safeInteger(row.tokens))) return null;
  if (!(row.exit === null || Number.isInteger(row.exit)) || !(row.effExit === null || Number.isInteger(row.effExit))) return null;
  if (!TURN_OUTCOMES.has(row.outcome) || typeof row.verdict !== "string") return null;
  if (row.usage !== undefined && (!row.usage || typeof row.usage !== "object" || Array.isArray(row.usage))) return null;
  if (row.containers !== undefined && (!Array.isArray(row.containers) || row.containers.length > 100 || row.containers.some(name => !stringWithin(name, 200)))) return null;
  if (!["cut", "stalled", "authFailed", "emptyOutput", "emptyTurn"].every(key => optionalBoolean(row, key))) return null;
  if (row.cutSignal !== undefined && (typeof row.cutSignal !== "string" || row.cutSignal.length > 80)) return null;
  if (row.extensions !== undefined && !safeInteger(row.extensions)) return null;
  if (row.boxMs !== undefined && !safeInteger(row.boxMs)) return null;
  return { ...row, id: row.id.toLowerCase(), verdict: row.verdict.slice(0, 600) };
}

export async function routeInsights({ res, q, P, req, auth, ctx }) {
  const { state, json, canon, now, body, scopeAllows, filterReadable, turnTelemetry, AUTH_MODE } = ctx;
    if (req.method === "POST" && P === "/telemetry/turns") {
      const b = await body(req);
      if (!Array.isArray(b?.rows)) return json(res, 400, { error: "rows array required" });
      if (b.rows.length > 100) return json(res, 400, { error: "at most 100 rows per request" });
      const rows = [];
      let dropped = 0;
      for (const candidate of b.rows) {
        const row = validTurnRow(candidate, now());
        if (row) rows.push(row); else dropped++;
      }
      const owner = scopeAllows(auth?.identity, "", "owner");
      if (AUTH_MODE !== "off" && !owner && rows.some(row => auth?.identity?.name !== `${row.persona}:${row.project}`)) {
        return json(res, 403, { error: "turn rows must name the signing seat" });
      }
      try {
        const result = await turnTelemetry.append(rows);
        return json(res, 200, { ok: true, stored: result.stored, duplicates: result.duplicates, dropped });
      } catch (error) {
        const reason = String(error?.message || error);
        process.stderr.write(`[trantor] turn telemetry store failed: ${reason}\n`);
        return json(res, 500, { error: `turn telemetry store failed: ${reason}` });
      }
    }
    if (req.method === "GET" && P === "/telemetry/turns") {
      const numberQuery = (value, fallback) => {
        if (value === undefined || value === "") return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const limit = Math.min(1000, Math.max(1, Math.floor(numberQuery(q.limit, 1000))));
      const rows = turnTelemetry.readRows({
        project: q.project || "", agent: q.agent || "",
        since: numberQuery(q.since, 0), until: numberQuery(q.until, Number.MAX_SAFE_INTEGER),
      });
      return json(res, 200, { rows: filterReadable(auth, rows, row => row.project || "").slice(0, limit) });
    }
    if (req.method === "GET" && P === "/economics") {   // the brain's books, surfaced: scrooge ledger + quota profile
      const out = { scrooge: null, lifetime: null, profile: null };
      try { out.profile = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "profile.json"), "utf8")).providers || {}; } catch {}
      try {
        const ledger = join(homedir(), ".token-scrooge", "calls.jsonl");
        const st = statSync(ledger);
        if (st.mtimeMs !== ledgerCache.mtimeMs) {   // ledger changed → reparse the whole file once
          const rows = readFileSync(ledger, "utf8").trim().split("\n")
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(c => c && c.ok);
          ledgerCache = { mtimeMs: st.mtimeMs, rows };
        }
        const rows = ledgerCache.rows;
        // Roll up a set of calls into spend + the frontier-model yardstick (~$15/M in, $75/M out,
        // same reference scrooge's own ledger uses) and the resulting savings.
        const rollup = calls => {
          const s = { calls: calls.length, tokens_in: 0, tokens_out: 0, cost_usd: 0, by_model: {} };
          for (const c of calls) {
            s.tokens_in += c.tokens_in || 0; s.tokens_out += c.tokens_out || 0; s.cost_usd += c.cost_usd || 0;
            const m = s.by_model[c.model] ||= { calls: 0, cost_usd: 0 };
            m.calls++; m.cost_usd += c.cost_usd || 0;
          }
          s.opus_equiv_usd = +(s.tokens_in * 15 / 1e6 + s.tokens_out * 75 / 1e6).toFixed(2);
          s.cost_usd = +s.cost_usd.toFixed(4);
          s.saved_usd = +Math.max(0, s.opus_equiv_usd - s.cost_usd).toFixed(2);
          return s;
        };
        // Named rolling windows the dashboard dropdown offers, all served in one response so
        // switching the selector is instant (no refetch) — cheap because the rows are cached.
        const nowS = now() / 1000;
        const WINDOWS = { "24h": 24, "week": 168, "month": 720, "quarter": 2160, "year": 8760 };
        out.windows = {};
        for (const [k, hrs] of Object.entries(WINDOWS)) out.windows[k] = rollup(rows.filter(c => c.ts >= nowS - hrs * 3600));
        out.lifetime = rollup(rows);                             // all-time running total
        out.lifetime.since_ts = rows.length ? rows[0].ts : null; // first ledgered call
        out.windows.lifetime = out.lifetime;
        // back-compat: `scrooge` is the window older dashboards read (honor ?hours= if passed)
        out.scrooge = q.hours ? rollup(rows.filter(c => c.ts >= nowS - Number(q.hours) * 3600)) : out.windows["24h"];
      } catch {}
      // --- card-based costs (FLOW v2): the orchestrator's OWN work, by costKind ---
      // NOTIONAL (Claude sub-agents/orchestrator — plan-covered) is kept STRICTLY SEPARATE from REAL
      // spend (Scrooge). We never sum them into one headline — that would imply we paid for plan-covered
      // tokens. Crew is subscription (no per-task $). Card ts is in ms (the scrooge ledger is in seconds).
      try {
        const WINDOWS_MS = { "24h": 864e5, week: 7 * 864e5, month: 30 * 864e5, quarter: 90 * 864e5, year: 365 * 864e5 };
        const costCards = state.tasks.filter(t => t.costKind || t.costUsd != null);
        const rollupCards = cards => {
          const byKind = {};
          for (const t of cards) {
            const k = t.costKind || "other";
            const e = byKind[k] ||= { count: 0, usd: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, by_model: {}, hasUsd: false };
            // a rolling cc-subagent card carries an invocation count; usd/tokens are already accumulated
            const n = t.count || 1;
            e.count += n;
            if (typeof t.costUsd === "number") { e.usd += t.costUsd; e.hasUsd = true; }
            if (t.tokens) { e.tokens_in += t.tokens.input || 0; e.tokens_out += t.tokens.output || 0; e.cache_read += t.tokens.cacheRead || 0; e.cache_write += t.tokens.cacheWrite || 0; }
            if (t.model) { const m = e.by_model[t.model] ||= { count: 0, usd: 0 }; m.count += n; m.usd += t.costUsd || 0; }
          }
          for (const e of Object.values(byKind)) { e.usd = +e.usd.toFixed(4); e.usd = e.hasUsd ? e.usd : null; }
          return byKind;
        };
        out.costKinds = {};
        const nowMs = now();
        for (const [k, ms] of Object.entries(WINDOWS_MS)) out.costKinds[k] = rollupCards(costCards.filter(t => (t.ts || 0) >= nowMs - ms));
        out.costKinds.lifetime = rollupCards(costCards);
        // per-project notional totals (subagent+orchestrator) so the dashboard can scope it like reliability
        const perProject = {};
        for (const t of costCards) {
          if (typeof t.costUsd !== "number") continue;
          if (t.costKind !== "subagent-notional" && t.costKind !== "orchestrator-notional") continue;
          perProject[canon(t.project)] = +((perProject[canon(t.project)] || 0) + t.costUsd).toFixed(4);
        }
        out.notionalByProject = perProject;
      } catch {}
      return json(res, 200, out);
    }
    if (req.method === "GET" && P === "/lessons") {
      const agent = (q.agent || "").toLowerCase();
      const ls = state.lessons.filter(l => l.scope === "global" || (agent && l.scope === agent));
      return json(res, 200, { lessons: ls });
    }
    // The self-learning loop, surfaced for the dashboard "Learning" sidebar: relay lessons grouped
    // (global / per-agent / per-project), per-LLM reliability from turn telemetry (+ daily series for
    // charts), and the Scrooge guardrails baked into each model's prompt (+ per-model economics).
    if (req.method === "GET" && P === "/learning") {
      const projOf = by => (by && by.includes(":")) ? by.split(":").pop() : "";
      // ts is ms (lessons) or s (ledger). Null-safe: a malformed record with a missing/bad
      // ts must not throw (new Date(NaN).toISOString() does) and 500 the whole endpoint — return null
      // and let callers skip that day-bucket.
      const dayOf = ts => { const n = Number(ts); if (!n) return null; const d = new Date(n > 2e10 ? n : n * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
      const ALL = "*";   // the cross-project ("All projects") bucket
      const out = { totals: {}, lessons: { global: [], byAgent: {}, byProject: {}, projects: [] }, agents: [], agentsByProject: {}, models: [], modelsByProject: {} };

      // relay lessons → global / by-agent / by-project (project derived from the recorder's session id)
      const projSet = new Set();
      for (const l of state.lessons) {
        const rec = { text: l.text, scope: l.scope, by: l.by || "", project: projOf(l.by), ts: l.ts || 0 };
        if (l.scope === "global") out.lessons.global.push(rec); else (out.lessons.byAgent[l.scope] ||= []).push(rec);
        if (rec.project) { (out.lessons.byProject[rec.project] ||= []).push(rec); projSet.add(rec.project); }
      }

      // per-LLM reliability from turn telemetry, bucketed BY PROJECT (+ a global ALL bucket) so the
      // sidebar's project filter scopes the charts. Each turn carries its own project.
      const totals = turnTelemetry.readTotals();
      const relAgg = {};       // scope -> agent -> {turns,failures,models:Set,lastFailure,days}
      const scopeModels = {};  // scope -> Set(model used)
      let totalTurns = 0, totalFails = 0;
      const bumpRel = (scope, t) => {
        const a = ((relAgg[scope] ||= {})[t.agent] ||= { agent: t.agent, turns: 0, failures: 0, models: new Set(), lastFailure: null, days: {} });
        a.turns += t.turns;
        a.failures += t.failed;
        for (const model of t.models) { a.models.add(model); if (model !== "default") (scopeModels[scope] ||= new Set()).add(model); }
        const d = (a.days[t.day] ||= { turns: 0, failures: 0 });
        d.turns += t.turns;
        d.failures += t.failed;
        if (t.lastFailure && (!a.lastFailure || t.lastFailure.ts > a.lastFailure.ts)) {
          a.lastFailure = { ts: t.lastFailure.ts, exit: t.lastFailure.exit, project: t.project || "" };
        }
      };
      for (const t of totals) {
        totalTurns += t.turns;
        totalFails += t.failed;
        bumpRel(ALL, t);
        if (t.project) { bumpRel(t.project, t); projSet.add(t.project); }
      }
      // lessons-accumulated-over-time per scope -> agent brand -> day (agent-scoped lessons only)
      const lessonAgg = {};
      for (const l of state.lessons) {
        if (l.scope === "global") continue; const d = dayOf(l.ts); if (!d) continue;
        const bump = scope => { (((lessonAgg[scope] ||= {})[l.scope] ||= {})[d]) = (lessonAgg[scope][l.scope][d] || 0) + 1; };
        bump(ALL); const p = projOf(l.by); if (p) bump(p);
      }
      const buildAgents = scope => Object.values(relAgg[scope] || {}).sort((a, b) => b.turns - a.turns).map(a => {
        const days = Object.keys(a.days).sort(); let cum = 0; const ld = (lessonAgg[scope] || {})[a.agent] || {};
        return { agent: a.agent, turns: a.turns, failures: a.failures, failRate: a.turns ? +(a.failures / a.turns).toFixed(3) : 0,
          lastFailure: a.lastFailure, models: [...a.models],
          series: {
            failRate: days.map(d => ({ day: d, turns: a.days[d].turns, failures: a.days[d].failures, rate: a.days[d].turns ? +(a.days[d].failures / a.days[d].turns).toFixed(3) : 0 })),
            lessons: Object.keys(ld).sort().map(d => ({ day: d, count: (cum += ld[d]) })),
          } };
      });

      // Scrooge guardrails (global per model) + per-model economics from the ledger, bucketed by project
      let guard = {}; try { guard = JSON.parse(readFileSync(join(homedir(), ".token-scrooge", "lessons.json"), "utf8")) || {}; } catch {}
      try { const lp = join(homedir(), ".token-scrooge", "calls.jsonl"); const st = statSync(lp); if (st.mtimeMs !== ledgerCache.mtimeMs) { const rows = readFileSync(lp, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && c.ok); ledgerCache = { mtimeMs: st.mtimeMs, rows }; } } catch {}
      const ledAgg = {};   // scope -> model -> {calls,ti,to,cost,days}
      const bumpLed = (scope, c) => {
        const m = ((ledAgg[scope] ||= {})[c.model] ||= { calls: 0, ti: 0, to: 0, cost: 0, days: {} });
        m.calls++; m.ti += c.tokens_in || 0; m.to += c.tokens_out || 0; m.cost += c.cost_usd || 0;
        const dk = dayOf(c.ts); if (dk) { const d = (m.days[dk] ||= { cost: 0, ti: 0, to: 0 }); d.cost += c.cost_usd || 0; d.ti += c.tokens_in || 0; d.to += c.tokens_out || 0; }
        (scopeModels[scope] ||= new Set()).add(c.model);
      };
      for (const c of ledgerCache.rows) { if (!c.model) continue; bumpLed(ALL, c); if (c.project) { bumpLed(c.project, c); projSet.add(c.project); } }

      const savedOf = (ti, to, cost) => +Math.max(0, ti * 15 / 1e6 + to * 75 / 1e6 - cost).toFixed(2);
      let totalGuardrails = 0;
      const mkModel = (scope, model, g) => {
        const gcount = Object.values(g || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
        if (scope === ALL) totalGuardrails += gcount;   // guardrails are global — count once
        const lm = (ledAgg[scope] || {})[model];
        return { model, guardrails: g || {}, guardrailCount: gcount, calls: lm ? lm.calls : 0, cost_usd: lm ? +lm.cost.toFixed(4) : 0,
          saved_usd: lm ? savedOf(lm.ti, lm.to, lm.cost) : 0,
          series: { saved: lm ? Object.keys(lm.days).sort().map(d => ({ day: d, saved: savedOf(lm.days[d].ti, lm.days[d].to, lm.days[d].cost) })) : [] } };
      };
      const buildModels = scope => {
        const keys = new Set(scopeModels[scope] || []);          // models used in this scope
        if (scope === ALL) for (const k of Object.keys(guard)) if (k !== "*") keys.add(k);   // global view also lists every guardrailed model
        const arr = [...keys].sort().map(m => mkModel(scope, m, guard[m]));
        if (guard["*"]) arr.unshift(mkModel(scope, "∗ all models", guard["*"]));   // guardrails that apply to every model
        return arr;
      };

      out.lessons.projects = [...projSet].sort();
      out.agents = buildAgents(ALL); out.models = buildModels(ALL);
      for (const p of out.lessons.projects) { out.agentsByProject[p] = buildAgents(p); out.modelsByProject[p] = buildModels(p); }

      out.totals = { lessons: state.lessons.length, guardrails: totalGuardrails, turns: totalTurns, failures: totalFails, failRate: totalTurns ? +(totalFails / totalTurns).toFixed(3) : 0, models: out.models.length };
      return json(res, 200, out);
    }
    return false;
}
