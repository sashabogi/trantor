// #13474: tokens spent on one contract since the seat's last commit, judged against a ceiling.
// Pure: the runner owns the counters and the sends, this decides whether the seat has burned out.
export const DEFAULT_BURN_CEILING = 1_000_000;

export function burnCeiling(env = process.env) {
  return Math.max(0, Number(env.TRANTOR_CARD_TOKEN_BUDGET || DEFAULT_BURN_CEILING));
}

/** The counters after a turn: a commit is progress and zeroes the count, anything else adds. */
export function afterTurn({ tokens, commits }, { spent, committed }) {
  return committed ? { tokens: 0, commits: commits + 1 } : { tokens: tokens + (spent > 0 ? spent : 0), commits };
}

/** null while under the ceiling; else the one message and the one card note for this episode. */
export function burnVerdict({ card, tokens, commits, ceiling, agent, stopped }) {
  if (stopped || ceiling <= 0 || !(card > 0) || tokens < ceiling) return null;
  const made = `${commits} commit(s) made on this contract`;
  const text = `⛔ #${card} hit its token budget: ${tokens} ≥ ${ceiling} tokens since the last commit, ${made}.`
    + ` Further turns for THIS card are paused until it moves (new contract, or testing/done) or \`trantor up ${agent}\` resets the budget.`;
  return { text, note: `parked at the burn ceiling: ${tokens} tokens spent since the last commit (ceiling ${ceiling}), ${made}.` };
}
