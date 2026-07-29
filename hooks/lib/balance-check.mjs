// trantor SessionStart balance check — the session env HAS the provider keys (the hub, under launchd,
// does not), so this is where we fetch prepaid credit, push a snapshot to the hub (for the dashboard),
// and surface a low-balance warning line. Throttled behind a 3h TTL stamp: most starts do ZERO network.
// Hard-capped at 4s so it can never noticeably slow a session start. Fail-silent by contract.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, isLow, fmtBalance, DEFAULT_LOW, DEFAULT_LOW_QUOTA_PCT } from "../../lib/balances.mjs";
import { loadProfile } from "../../bin/profile.mjs";
import { resolveKeys } from "../../lib/provider-keys.mjs";
import { signedPost } from "./api.mjs";

const STAMP = join(homedir(), ".agent-bus", "balances-check.json");
const TTL_MS = 3 * 3600 * 1000;
const CAP_MS = 4000;

function thresholds() {
  let t = DEFAULT_LOW, q = DEFAULT_LOW_QUOTA_PCT;
  try { const c = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); if (c.lowBalance) t = { ...DEFAULT_LOW, ...c.lowBalance }; if (typeof c.lowQuotaPct === "number") q = c.lowQuotaPct; } catch {}
  return { t, q };
}

// Returns { low: [{label, line}], cached } — `low` is the list of providers below their refill threshold.
export async function maybeCheckBalances() {
  if (process.env.TRANTOR_NO_BALANCE_CHECK === "1") return { low: [] };
  let stamp = {}; try { stamp = JSON.parse(readFileSync(STAMP, "utf8")); } catch {}
  if (stamp.ts && Date.now() - stamp.ts < TTL_MS) return { low: stamp.low || [], cached: true };

  // only the providers configured in `trantor profile` (never stray ambient-env keys)
  const only = Object.keys(loadProfile().providers || {});
  if (!only.length) return { low: [] };   // no profile → nothing to report

  let balances;
  try { balances = await Promise.race([fetchBalances(resolveKeys(process.env), { only }), new Promise((_, rej) => setTimeout(() => rej(new Error("cap")), CAP_MS))]); }
  catch { return { low: stamp.low || [] }; }   // timed out / errored — keep the last known low list, don't rewrite the stamp
  if (!Array.isArray(balances) || !balances.length) { try { writeFileSync(STAMP, JSON.stringify({ ts: Date.now(), low: [] })); } catch {} return { low: [] }; }

  // push the fresh snapshot to the hub for the dashboard + other sessions (best-effort, signed)
  await signedPost("/balances", { balances, ts: Date.now(), by: process.env.TRANTOR_SESSION || "" }, { timeoutMs: 2000 });

  const { t, q } = thresholds();
  const low = balances.filter(b => isLow(b, t, q)).map(b => ({ label: b.label, line: fmtBalance(b) }));
  try { writeFileSync(STAMP, JSON.stringify({ ts: Date.now(), low })); } catch {}
  return { low };
}
