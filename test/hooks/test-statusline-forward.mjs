#!/usr/bin/env node
// #12094 — the statusline forwarder carries Claude Code's `prompt_cache` object to the hub next to
// rate_limits, and the pure decoders behind the staleness line and the model-switch register body.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";
import { promptCacheOf, staleResumeLine, modelSwitchRegister } from "../../hooks/lib/cc-signals.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  ${detail}` : ""}`); cond ? pass++ : fail++; };

console.log("# promptCacheOf / staleResumeLine / modelSwitchRegister");
const pcIn = { warm: true, ttl: "1h", hit_ratio: 0.91, requests: 14, misses: 2, recache_tokens_if_cold: 45000,
  last_miss_cause: { causes: ["tools_changed"], tools_added: 2 }, expires_at: 1738429200 };
const pc = promptCacheOf({ prompt_cache: pcIn });
ok("prompt_cache maps to camelCase", pc.warm === true && pc.hitRatio === 0.91 && pc.ttl === "1h" && pc.recacheTokensIfCold === 45000 && pc.lastMissCause === "tools_changed");
ok("a null hit_ratio stays null", promptCacheOf({ prompt_cache: { warm: false, hit_ratio: null } }).hitRatio === null);
ok("absent or non-object prompt_cache is null", promptCacheOf({}) === null && promptCacheOf({ prompt_cache: "x" }) === null && promptCacheOf(null) === null);

const resume = { source: "resume", seconds_since_last_response: 5400, context_tokens: 182340, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396 };
const line = staleResumeLine(resume);
ok("resume line states age, expiry and cost", line.includes("1.5h") && line.includes("likely expired") && line.includes("$1.14") && line.includes("182k"), line);
ok("resume line is one line", !line.includes("\n"));
ok("no line without the fields", staleResumeLine({ source: "resume" }) === "");
ok("no line on a startup", staleResumeLine({ ...resume, source: "startup" }) === "");
ok("a warm short gap reads warm in seconds", /45s stale, prompt cache probably still warm/.test(staleResumeLine({ source: "resume", seconds_since_last_response: 45 })));

const body = modelSwitchRegister({ to_model: "claude-opus-5", from_model: "claude-sonnet-5" }, { session: "h:p", project: "p" });
ok("model switch register body carries the new model", body.model === "claude-opus-5" && body.session === "h:p" && body.project === "p" && body.llm === "claude");
ok("no to_model means no body", modelSwitchRegister({}, { session: "s", project: "p" }) === null);

console.log("# statusline forwarder against a hub");
const W = realpathSync(mkdtempSync(join(tmpdir(), "trantor-sl-")));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
writeFileSync(join(W, ".agent-bus", "profile.json"), JSON.stringify({ providers: { claude: "max" } }));
const hub = await startTestHub({ dir: W });
const run = (j) => spawnSync("node", ["hooks/statusline.mjs"], {
  input: JSON.stringify(j), encoding: "utf8", timeout: 20000, cwd: process.cwd(),
  env: drillEnv({ HOME: W, RELAY_URL: hub.base, RELAY_SESSION: "sl:probe" }),
});
const claude = async () => (await (await fetch(hub.base + "/balances")).json()).entries?.find(e => e.provider === "claude");
try {
  const both = run({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 30, resets_at: 1788200000 } }, prompt_cache: pcIn });
  ok("forwarder exits clean and prints nothing", both.status === 0 && both.stdout === "", both.stderr);
  const e1 = await claude();
  ok("hub holds the 5h window", e1?.windows?.find(w => w.name === "5h")?.usedPct === 30, JSON.stringify(e1));
  ok("hub holds the prompt cache beside it", e1?.promptCache?.hitRatio === 0.91 && e1.promptCache.warm === true, JSON.stringify(e1?.promptCache));

  run({ session_id: "s2", prompt_cache: { ...pcIn, hit_ratio: 0.5 } });
  const e2 = await claude();
  ok("a tick with only prompt_cache is forwarded", e2?.promptCache?.hitRatio === 0.5, JSON.stringify(e2?.promptCache));
  ok("the earlier window survives a cache-only tick", e2?.windows?.find(w => w.name === "5h")?.usedPct === 30);

  run({ session_id: "s3", prompt_cache: { ...pcIn, hit_ratio: 0.1 }, rate_limits: { five_hour: { used_percentage: 31, resets_at: 1788200000 } } });
  const e3 = await claude();
  ok("a tick with neither is a free no-op", run({ session_id: "s4" }).status === 0 && (await claude())?.promptCache?.hitRatio === e3?.promptCache?.hitRatio);
} finally {
  await hub.stop();
  rmSync(W, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
