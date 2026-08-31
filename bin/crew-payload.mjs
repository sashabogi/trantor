// Payload composition for crew-runner turn prompts — pure, unit-testable (card #5683).
//
// A fresh codex seat burned 306k tokens and crash-looped into a remote-compact 404. The runner-side
// part of that: every turn re-feeds the FULL lessons block (22,298 of the 24,698 chars in codex's
// last turn file — 90%), plus an unbounded FYI-broadcast backlog that grows across a failure streak
// and is replayed on every redelivery, on a RESUMED session where it all stacks. So every section
// here is capped, and the assembled prompt has ONE hard total cap with a visible truncation notice.
// Below the caps the output is byte-identical to the old string concatenation.

export const PAYLOAD_CAPS = Object.freeze({
  wakeCount: 10,       // direct/@mention messages: keep the last ~10
  wakeMsgChars: 2000,  // per-message body cap (the hub caps card notes at 2000 too)
  bcastCount: 10,      // FYI broadcast context: keep the last ~10
  bcastMsgChars: 1000,
  lessonsCount: 15,    // top ~15 lessons, ranked by relevance to this turn's trigger
  lessonsChars: 16000,
  totalChars: 40000,   // ONE hard total cap for the whole prompt
});

const WORD_RE = /[a-z0-9]{4,}/g;
const n = v => Number(v).toLocaleString("en-US");

// ---- wake messages (the task): keep the last `wakeCount`, cap each body ----
export function capWake(wake, caps = PAYLOAD_CAPS) {
  const list = Array.isArray(wake) ? wake : [];
  const kept = list.slice(-caps.wakeCount);
  const lines = kept.map(m => {
    let body = String(m?.text ?? "");
    if (body.length > caps.wakeMsgChars)
      body = body.slice(0, caps.wakeMsgChars) + ` …[+${n(body.length - caps.wakeMsgChars)} chars of this message dropped]`;
    return `[${m?.from}${m?.to === "all" ? " -> all (mentions you)" : ""}]: ${body}`;
  });
  return { text: lines.join("\n"), kept: kept.length, total: list.length };
}

// ---- FYI broadcast context (context only): keep the last `bcastCount`, cap each body ----
export function capBcast(bcast, caps = PAYLOAD_CAPS) {
  const list = Array.isArray(bcast) ? bcast : [];
  const kept = list.slice(-caps.bcastCount);
  const lines = kept.map(m => {
    let body = String(m?.text ?? "");
    if (body.length > caps.bcastMsgChars)
      body = body.slice(0, caps.bcastMsgChars) + ` …[+${n(body.length - caps.bcastMsgChars)} chars dropped]`;
    return `[${m?.from} -> all]: ${body}`;
  });
  return { text: lines.join("\n"), kept: kept.length, total: list.length };
}

// ---- lessons: top `lessonsCount` ranked by word overlap with this turn's trigger, then char-capped.
// No trigger (kickoff/pulse) → no signal to rank on, so original order stands.
export function pickLessons(lessons, trigger = "", caps = PAYLOAD_CAPS) {
  const list = Array.isArray(lessons) ? lessons.filter(Boolean) : [];
  if (!list.length) return { text: "", kept: 0, total: 0 };
  const tw = new Set(String(trigger).toLowerCase().match(WORD_RE) || []);
  const ranked = list
    .map((l, i) => {
      const words = String(l?.text || "").toLowerCase().match(WORD_RE) || [];
      let score = 0;
      for (const w of words) if (tw.has(w)) score++;
      return { l, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, caps.lessonsCount)
    .sort((a, b) => a.i - b.i);
  let budget = caps.lessonsChars;
  const lines = [];
  for (const { l } of ranked) {
    const line = `- [${l?.scope}] ${l?.text}`;
    if (line.length > budget) continue;   // doesn't fit — a shorter one may
    budget -= line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return { text: "", kept: 0, total: list.length };
  return {
    text: "\n\nLESSONS from previous crews (hard-won — follow them):\n" + lines.join("\n"),
    kept: lines.length,
    total: list.length,
  };
}

// ---- one composer, one hard total cap ----
// sections: [{ name, text, trim?, order? }] joined in order. `trim: "drop"` removes the whole
// section when the total is over `totalChars` (lowest `order` dropped first); `trim: "truncate"`
// cuts the section to the remaining budget. Sections without `trim` are never touched — they are
// the runner-authored frame. The payload carries a visible notice naming every trim.
export function composePrompt(sections, caps = PAYLOAD_CAPS) {
  const secs = sections.map(s => ({ ...s, text: String(s?.text ?? "") }));
  let total = secs.reduce((a, s) => a + s.text.length, 0);
  const dropped = [];
  const trimmable = secs.filter(s => s.trim).sort((a, b) => a.order - b.order);
  for (const s of trimmable) {
    if (total <= caps.totalChars) break;
    if (s.trim === "drop") {
      dropped.push(`${s.name} (${n(s.text.length)} chars dropped)`);
      total -= s.text.length;
      s.text = "";
    } else {
      const rest = total - s.text.length;
      const budget = Math.max(0, caps.totalChars - rest);
      dropped.push(`${s.name} (${n(s.text.length)} → ${n(budget)} chars)`);
      s.text = s.text.slice(0, budget) + " …[truncated — payload hit the hard cap]";
      total = rest + s.text.length;
    }
  }
  const prompt = secs.map(s => s.text).join("")
    + (dropped.length
      ? `\n\n[PAYLOAD TRUNCATED: hard cap ${n(caps.totalChars)} chars — ${dropped.join("; ")}.]`
      : "");
  return {
    prompt,
    sections: secs.map(s => ({ name: s.name, chars: s.text.length })),
    truncated: dropped.length > 0,
    dropped,
  };
}
