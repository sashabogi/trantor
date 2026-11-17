// #13474: one definition of "which provider does this seat label promise", shared by patrol (warn)
// and the runner (refuse the turn), so the two can never disagree about a mismatch.
const SUBSCRIPTION = new Set(["codex", "kimi", "claude", "gemini"]);   // flat-fee plans, never metered
const METERED = new Set(["deepseek", "openrouter"]);                   // pay-per-token providers
const OWN_MODEL = new Set(["dsh", "opencode"]);                        // label does not pin a provider

/** The label's base CLI: "kimi-13" and "host:kimi-13" both read as "kimi". */
export function seatBase(label) {
  const tail = String(label || "").split(":").pop();
  const base = tail.replace(/-\d+$/, "");
  return SUBSCRIPTION.has(base) || OWN_MODEL.has(base) || base === "glm" ? base : tail;
}

/** The provider a provider-labelled seat must run on, or null when the label pins none. */
export function seatProvider(agent) {
  const base = seatBase(agent);
  if (SUBSCRIPTION.has(base) || OWN_MODEL.has(base)) return null;
  return base === "glm" ? "zai-coding-plan" : base;
}

/** null when label and live model agree; else { label, model, expected, actual } for the refusal. */
export function providerMismatch(label, model) {
  const m = String(model || "");
  const actual = m.split("/")[0];
  if (!actual) return null;
  const expected = seatProvider(label);
  if (expected) return actual !== expected ? { label, model: m, expected, actual } : null;
  if (SUBSCRIPTION.has(seatBase(label)) && METERED.has(actual)) {
    return { label, model: m, expected: "a subscription provider", actual };
  }
  return null;
}
