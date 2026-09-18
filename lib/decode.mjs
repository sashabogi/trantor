/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this module IS the I/O boundary decoder for
   lib/. Everything it is handed came off disk (config.json, autonomy.json, model-catalog.json), out
   of a JSONL transcript written by whatever CLI version produced it, or off an HTTP request — the
   type of any field is exactly what cannot be assumed, so these typeof checks are the parse that
   establishes the contract, not a substitute for one (#7174). */
// Each helper returns the value at its known shape or null, so callers branch on a domain value.
// Deliberately permissive where the inline checks they replaced were: asRecord admits arrays and
// asNumber admits NaN, because `typeof x === "object"` and `typeof x === "number"` did (#7174).

export function asRecord(v) { return v && typeof v === "object" ? v : null; }
export function asString(v) { return typeof v === "string" ? v : null; }
export function asNumber(v) { return typeof v === "number" ? v : null; }
export function asFunction(v) { return typeof v === "function" ? v : null; }
