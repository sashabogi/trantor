// STREAMING — the chat's state machine, pure on purpose.
//
// The transcript cursor is the whole game. Claude writes COMPLETE JSONL rows while a turn runs,
// and the watcher (#5474) pushes each new batch as a `chat-rows` event whose `after` is the line
// offset the batch starts at. Rows only ever append when `after` matches what we have already
// folded in; anything else means a batch was missed and the caller refetches via
// `orchestrator_chat`, whose `total` is the authoritative line count.
//
// Why a batch's own cursor can drift: not every transcript line becomes a turn. System rows,
// harness injections and pure tool_result lines advance the file without producing a Turn, so
// `after + turns.length` is a lower bound, not the truth. The mismatch path heals the drift —
// a wrong guess costs one refetch, never a gap and never a duplicate. When the watcher offers
// the post-batch line count as `total`, the guess becomes exact and the heals stop.
export type Block = { kind: "text" | "thinking" | "tool" | "image" | "divider"; text: string; tool?: string; tool_id?: string };
export type Turn = { role: "user" | "assistant" | "system"; blocks: Block[] };
export type ToolResult = { tool_id: string; ok: boolean; preview: string };
/** The context window as the transcript's usage rows report it (#5508). `tokens`/`frac` are null
 *  until an assistant row with usage has been seen; `window` is 0 when unset — an unknown window
 *  renders as absent, never as a guessed default that would look like knowledge. */
export type ContextGauge = { tokens: number | null; window: number; frac: number | null };
/** What the agent IS, reported by the session itself. Empty means unknown, and unknown renders as
 *  absent rather than as a default that would look like knowledge. */
export type Meta = { model: string; version: string; branch: string; context: ContextGauge };

export type ChatState = {
  turns: Turn[];
  /** Results merged by tool_use id — a result arrives lines after the call it answers, so it fills
   *  the card that has been on screen rather than rendering in place. */
  results: Record<string, ToolResult>;
  /** Transcript lines already folded into `turns`. Authoritative from `orchestrator_chat.total`;
   *  a guess after an event batch (see above). */
  seen: number;
  meta: Meta;
  /** A session handoff was observed — the thread restarted under a "session continued" divider. */
  continued: boolean;
};

export const emptyChat: ChatState = {
  turns: [], results: {}, seen: 0,
  meta: { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } },
  continued: false,
};

/** One `chat-rows` event. `after` is the line offset of the batch's first row; `total`, when the
 *  watcher offers it, is the post-batch line count that makes the cursor exact. */
export type RowsPayload = {
  project: string; sessionId: string; after: number;
  turns: Turn[]; results: ToolResult[]; meta: Meta; total?: number;
};
/** One `chat-session-changed` event: the watcher saw the mapped session id move (handoff/adopt)
 *  and is following the NEW transcript from line 0. */
export type SessionPayload = { project: string; sessionId: string };
/** What `orchestrator_chat` returns: [new turns, new results, total line count, meta]. */
export type Backfill = [Turn[], ToolResult[], number, Meta];

/** Absorb one decoded batch into the state. Shared by the poll path and the event path so they
 *  cannot disagree about what an arrival means. */
function absorb(s: ChatState, fresh: Turn[], rs: ToolResult[], m: Meta): ChatState {
  const results = { ...s.results };
  for (const r of rs) results[r.tool_id] = r;
  return {
    ...s,
    turns: fresh.length ? [...s.turns, ...fresh] : s.turns,
    results,
    // Spread semantics inherited from the poll this replaces: a field the batch carries wins, even
    // as an empty string. Identity comes from the LAST assistant entry, so a model switch
    // mid-session lands as soon as its row does.
    meta: { ...s.meta, ...m },
  };
}

/** Apply one `chat-rows` batch. In order → append and advance the cursor. Out of order → resync:
 *  the payload is DISCARDED untouched and the caller refetches, because a cursor mismatch means a
 *  batch was missed and guessing where these rows belong is how gaps and duplicates happen. */
export function applyRows(s: ChatState, p: RowsPayload): { state: ChatState; resync: boolean } {
  if (p.after !== s.seen) return { state: s, resync: true };
  const cursor = p.total ?? p.after + p.turns.length;
  return { state: { ...absorb(s, p.turns, p.results, p.meta), seen: cursor }, resync: false };
}

/** Apply one `orchestrator_chat` answer fetched at line `after`. The append only goes through when
 *  the state is still where the fetch started — a second answer that left after an earlier one
 *  landed is entirely subsumed by it, and appending again would duplicate every row. */
export function applyBackfill(s: ChatState, b: Backfill, after: number): ChatState {
  const [fresh, rs, total, m] = b;
  if (s.seen !== after) return total > s.seen ? { ...s, seen: total } : s;
  return { ...absorb(s, fresh, rs, m), seen: Math.max(total, after) };
}

/** A session change: everything from the old session stops mattering. Clear the thread, restart
 *  the cursor at 0, and mark the restart so the view can say "session continued" instead of
 *  silently interleaving two sessions' rows. Takes the prior state and deliberately reads none
 *  of it — the shape keeps it a state transition like its siblings. */
export function applySessionChanged(_s: ChatState): ChatState {
  return { ...emptyChat, continued: true };
}

/** Can the operator talk to the orchestrator, and if not, why — for the composer's disabled
 *  state (#5477). Liveness is asked of the pane (orchestrator_status → herdr's agent list), not
 *  guessed from a pane row existing: a registered pane whose agent exited is exactly the dead
 *  surface this check exists to catch. "none"/"unknown" are the closed not-live set — herdr only
 *  lists agents it vouches for, so any OTHER status (idle, working, …) means one is running. */
export function sessionLiveness(status: string, target: string | null): { live: boolean; why: string } {
  if (target === null) {
    return { live: false, why: "no orchestrator pane is hosted for this project yet — open one from the Workspace lens" };
  }
  if (status === "none") {
    return { live: false, why: "no orchestrator session is behind this pane — open one from the Workspace lens" };
  }
  if (status === "unknown") {
    return { live: false, why: "the pane is not running an agent right now" };
  }
  return { live: true, why: "" };
}

/** A message the composer sent that the transcript has not yet echoed back (#5504). */
export type PendingSend = { text: string; at: number };

/** Silence past this window means the words never made it into the conversation. */
export const LOST_AFTER_MS = 10_000;

/** Judge one pending send against the transcript's user turns.
 *
 *  Sending is not delivery: text typed into the pane can be eaten by whatever UI state the CLI is
 *  in (2026-08-28: two dictated messages vanished into a compacting TUI, and one fused onto a
 *  staged "/compact"). The transcript is the only truth about arrival, so the composer holds each
 *  send as pending until a user turn CONTAINS it — containment, not equality, because a fused row
 *  is still delivered, just dirty. "lost" only after the window: silence before that is transit. */
export function receiptFor(p: PendingSend, userTexts: string[], now: number): "sending" | "delivered" | "lost" {
  if (p.text && userTexts.some(t => t.includes(p.text))) return "delivered";
  return now - p.at > LOST_AFTER_MS ? "lost" : "sending";
}

/** The gauge's colour contract (#5508): hidden while `frac` is unknown, quiet below 75%, amber
 *  from 75%, red from 90%. Thresholds are exact — 0.75 IS amber and 0.90 IS red. */
export function gaugeTone(frac: number | null): "hidden" | "neutral" | "amber" | "red" {
  if (frac === null) return "hidden";
  if (frac >= 0.90) return "red";
  if (frac >= 0.75) return "amber";
  return "neutral";
}

/** The gauge's tooltip, exactly "489k / 1000k (49%)" — k-rounded tokens out of window with the
 *  percent, so the bar and the number can never disagree. Only called while the gauge shows. */
export function gaugeLabel(c: ContextGauge): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return `${k(c.tokens ?? 0)} / ${k(c.window)} (${Math.round((c.frac ?? 0) * 100)}%)`;
}

/** Bookkeeping never wears the user's face (#5502). A turn renders as a divider — centered, quiet,
 *  never a bubble — when the decoder called it `system`, and a divider BLOCK stays a divider even
 *  if it rides a non-system turn: the block kind is the Rust-side gate's verdict, not a hint. */
export function isDividerTurn(t: Turn): boolean {
  return t.role === "system" || t.blocks.some(b => b.kind === "divider");
}

/** Splice dropped file paths into the draft at the caret, each followed by one trailing space —
 *  the same splice the @-accept performs (#5507). Pure on purpose: the drop event hands over
 *  paths, the cursor does the placing, and this decides the text. */
export function insertPaths(draft: string, cursor: number, paths: string[]): string {
  const insertion = paths.map(p => `${p} `).join("");
  return draft.slice(0, cursor) + insertion + draft.slice(cursor);
}
