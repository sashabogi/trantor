// Pure decoders for the cheap signals Claude Code puts in hook and status line JSON, so the hooks
// stay thin and the field names live in one place (docs/SYSTEM-CONTRACT.md section 9).

const num = (v) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// Status line `prompt_cache` object (CC 2.1.251+) reduced to what the board shows; null when absent.
export function promptCacheOf(j) {
  const p = j?.prompt_cache;
  if (!p || Array.isArray(p) || !(p instanceof Object)) return null;
  const cause = p.last_miss_cause?.causes;
  return {
    warm: p.warm === true,
    hitRatio: num(p.hit_ratio),
    requests: num(p.requests),
    misses: num(p.misses),
    ttl: p.ttl === "1h" || p.ttl === "5m" ? p.ttl : null,
    recacheTokensIfCold: num(p.recache_tokens_if_cold),
    lastMissCause: Array.isArray(cause) && cause.length ? String(cause[0]).slice(0, 40) : null,
  };
}

// One line for a resumed SessionStart (CC 2.1.251+): how stale the session is and what re-caching
// it costs. Empty string unless this is a resume/fork and the staleness fields are present.
export function staleResumeLine(input) {
  if (input?.source !== "resume" && input?.source !== "fork") return "";
  const secs = num(input.seconds_since_last_response);
  if (secs === null) return "";
  const age = secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : secs >= 60 ? `${Math.round(secs / 60)}m` : `${Math.round(secs)}s`;
  const usd = num(input.estimated_cache_write_usd);
  const toks = num(input.context_tokens);
  const cold = input.prompt_cache_likely_expired === true;
  const cost = usd !== null ? `, re-caching ${toks !== null ? `${Math.round(toks / 1000)}k tokens ` : ""}costs about $${usd.toFixed(2)}` : "";
  return `Resumed session is ${age} stale, prompt cache ${cold ? "likely expired" : "probably still warm"}${cost}; a fresh session may be cheaper.`;
}

// PostModelSwitch input (CC 2.1.251+) to the /register body that tells the hub the session's model
// right now, instead of waiting for the next heartbeat to read it off the transcript. Null if no model.
export function modelSwitchRegister(input, { session, project, llm = "claude" }) {
  const model = String(input?.to_model || "").trim();
  if (!model) return null;
  return { session, project, llm, model: model.slice(0, 60) };
}
