/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Cost fields are legacy card-envelope variants and the extraction must retain exact output omission semantics. */
const PHASE_GAP_MS = 8 * 60 * 60 * 1000;
const agentBrand = (a) => { const s = String(a || ""); const i = s.indexOf(":"); return i > 0 ? s.slice(0, i) : (s || ""); };
// Crew = a known helper-CLI brand; anything else with a brand (a machine hostname like
// "MacBook-Pro-M1.local" or "MacBookPro.hsd1.fl.comcast.net", or a generic "host") is the
// orchestrator. Brand-based (not hostname-pattern) so it's robust to hostname instability.
const CREW_BRANDS = /^(codex|gemini|kimi|deepseek|claude|qwen|grok|glm|mistral|llama)$/i;
const isOrchAssignee = (a) => { const b = agentBrand(a); return !!b && !CREW_BRANDS.test(b); };
function phaseFamily(title) {
  const s = String(title || "").trim();
  // "P5a Structured…", "P4-construction", "P3 Quantity" → P5/P4/P3 (group all P5a/b/c/d together).
  // The trailing letter and the separator must NOT be swallowed by \b (P5a has none between 5 and a).
  let m;
  if ((m = s.match(/^P(\d+)[a-z]?(?:[\s\-:.]|$)/i))) return "P" + m[1];
  if (/^CBv?\d/i.test(s) || /^CBfix/i.test(s) || /^CB[\s\-:.]/i.test(s)) return "CB";
  if (/^FA[\s\-:.\d]/i.test(s)) return "FA";
  if (/^RunCost/i.test(s)) return "RunCost";
  return null;
}
function phaseStatus(counts) {
  if (counts.failed) return "failed";
  if (counts.doing || counts.testing) return "active";
  const total = counts.todo + counts.doing + counts.testing + counts.failed + counts.done + counts.blocked + (counts.stale || 0);
  if (total > 0 && counts.done === total) return "done";
  if (counts.blocked) return "blocked";
  if (counts.todo === total) return "planned";
  return "active";
}
// A human "what is this phase about" line derived from the cards themselves: strip the phase-prefix
// token, take the subject before the first em/en-dash, dedupe, join the first few. Retroactive — no
// captured plan needed. An explicit phase goal (phaseMeta) overrides this in the /phases endpoint.
function phaseTheme(cards) {
  const subs = [];
  const seen = new Set();
  for (const c of cards) {
    let s = String(c.title || "")
      // drop the phase token INCLUDING any sub-index (P3.5, P5a, CBv2-1) + separators, so no "1"/".5" leaks
      .replace(/^\s*(P\d+[a-z]?(?:[.\-]\d+)?|CBv?\d+(?:[.\-]\d+)?|CBfix|FA[-\s:]?\w*|RunCost)[\s:\-–—#]*/i, "")
      .split(/[—–]| - /)[0].trim();                                                    // subject before a dash
    if (!s) continue;
    const k = s.toLowerCase().slice(0, 22);
    if (seen.has(k)) continue;
    seen.add(k); subs.push(s.slice(0, 48));
    if (subs.length >= 3) break;
  }
  return subs.join(" · ").slice(0, 120);
}
export function derivePhases(tasks) {
  const sorted = [...tasks].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let miscRound = 0, lastMiscTs = 0;
  for (const t of sorted) {
    // an explicit phase tag (set at plan time) wins; else infer from the title prefix; else time-cluster.
    const explicit = t.phase && String(t.phase).trim();
    const fam = explicit || phaseFamily(t.title);
    if (fam) { t._phase = fam; }
    else {
      if (!lastMiscTs || (t.ts || 0) - lastMiscTs > PHASE_GAP_MS) miscRound++;
      lastMiscTs = t.ts || lastMiscTs;
      t._phase = `Setup ${miscRound}`;
    }
  }
  const byPhase = new Map();
  for (const t of sorted) { if (!byPhase.has(t._phase)) byPhase.set(t._phase, []); byPhase.get(t._phase).push(t); }
  const phases = [...byPhase.entries()].map(([key, cards]) => {
    const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0, stale:0 };
    for (const c of cards) counts[c.status] = (counts[c.status] || 0) + 1;
    const node = (c) => ({ id: c.id, title: c.title, assignee: c.assignee || "", agent: agentBrand(c.assignee), model: c.model || "", status: c.status, difficulty: c.difficulty || "", ts: c.ts || 0, updated: c.updated || c.ts || 0, deps: Array.isArray(c.deps) ? c.deps : [], costKind: c.costKind || "", costUsd: (typeof c.costUsd === "number") ? c.costUsd : null, source: c.source || "", count: c.count || 1 });
    const crew = cards.filter(c => !isOrchAssignee(c.assignee)).map(node);
    const orchestrators = cards.filter(c => isOrchAssignee(c.assignee)).map(node);
    return {
      key, label: key, theme: phaseTheme(cards),
      start: Math.min(...cards.map(c => c.ts || 0)), end: Math.max(...cards.map(c => c.updated || c.ts || 0)),
      counts, total: cards.length, status: phaseStatus(counts),
      agents: [...new Set(crew.map(c => c.agent).filter(Boolean))],
      crew, orchestrators,
    };
  }).sort((a, b) => a.start - b.start);
  const miscCount = sorted.filter(t => /^Setup /.test(t._phase)).length;
  return { phases, total: sorted.length, sparse: sorted.length > 0 && miscCount / sorted.length > 0.5, derivedBy: "title-prefix + time-cluster" };
}
