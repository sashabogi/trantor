// Pure, testable guards for the SubagentStop cost hook (extracted so they have regression coverage).
// The v0.17.37 bug: findTranscript() summed the PARENT session transcript (1000+ turns, 100s of M
// cache-read) onto tiny recall/handoff sub-agent cards → tens of thousands of $ bogus notional.
import { basename } from "node:path";

// A real sub-agent transcript lives under a /subagents/ tree and is named agent-<id>.jsonl. The MAIN
// session transcript is <session-uuid>.jsonl at the project root — never accept it as a sub-agent's.
export function isSubagentTranscript(p) {
  if (!p) return false;
  return /(^|[\/\\])subagents[\/\\]/.test(p) && /[\/\\]agent-[^\/\\]*\.jsonl$/.test(p);
}

// A single sub-agent with >50M cache-read (or >$50 notional) is almost certainly a mis-resolved
// transcript. Real agents top out ~40M cache-read / ~$30. Treat as suspect → don't record a cost.
export const SUSPECT_CACHE_READ = 50e6;
export const SUSPECT_USD = 50;
export function isImplausibleCost({ usd = null, cacheRead = 0 } = {}) {
  // usd's contract is number|null (computed token cost); the null check keeps the absent case
  // from comparing, and non-numbers outside that contract never fire the suspicion either way.
  return (cacheRead || 0) > SUSPECT_CACHE_READ || (usd !== null && usd > SUSPECT_USD);
}
