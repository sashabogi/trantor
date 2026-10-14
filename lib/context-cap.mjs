// #11855: the card context cap. The runner reads the last step's processed input after a clean
// card turn; this decides what to do with it. Pure: no I/O, no clock, no env.

export const capConfig = (env = process.env) => ({
  cap: Math.max(0, Number(env.TRANTOR_CARD_CONTEXT_CAP || 120_000)),
  minSteps: Math.max(1, Number(env.TRANTOR_CARD_CAP_MIN_STEPS || 5)),
  maxHandoffs: Math.max(1, Number(env.TRANTOR_CARD_CAP_MAX_HANDOFFS || 3)),
});

// -> "none" | "handoff" | "log-exhausted" (post the one card note) | "exhausted" (already posted)
export function capDecision({ cap, minSteps, maxHandoffs, step, turn, freshTurn, handoffs = 0, logged = false }) {
  if (!(cap > 0) || !Number.isFinite(step) || step <= cap) return "none";
  if (handoffs >= maxHandoffs) return logged ? "exhausted" : "log-exhausted";
  if (turn - freshTurn < minSteps) return "none";
  return "handoff";
}

export const capHandoffPrompt = (card) => `this session's context passed the card context cap and a fresh session takes over card #${card} next. Add ONE note to card #${card} (relay_task_move keeping its current status) prefixed "HANDOFF (context cap):" holding: the goal in one line, the current state with the sha you verified at, the key decisions, the next steps, and the key files (paths). Then end your turn: the fresh session continues from your note.`;

export const capPointerLine = (card) => `\n(FRESH SESSION for card #${card}: the previous session hit the context cap and left a card note prefixed "HANDOFF (context cap):". Read it with relay_board card:${card} and continue from it.)\n`;

export const capExhaustedNote = (card, cap, step, handoffs, maxHandoffs) =>
  `context cap: #${card} is past ${cap} processed tokens/step again after ${handoffs} handoffs (max ${maxHandoffs}); carrying on, CARD_TOKEN_BUDGET stays the backstop (last step ${step})`;
