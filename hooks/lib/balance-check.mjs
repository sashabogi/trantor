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
  // JSON.parse is the boundary: config.json can hold any JSON number but never NaN/Infinity,
  // so Number.isFinite accepts exactly the numeric lowQuotaPct values the old typeof did.
  try { const c = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); if (c.lowBalance) t = { ...DEFAULT_LOW, ...c.lowBalance }; if (Number.isFinite(c.lowQuotaPct)) q = c.lowQuotaPct; } catch {}
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
  const snap = { balances, ts: Date.now(), by: process.env.TRANTOR_SESSION || "" };
  await signedPost("/balances", snap, { timeoutMs: 2000 });
  // The desktop reads balances from the LOCAL hub (machine-local data); a pinned project's
  // default push lands on the REMOTE one — the 11-day-stale-header bug. Push both.
  await signedPost("http://127.0.0.1:4477/balances", snap, { timeoutMs: 2000 }).catch(() => {});

  const { t, q } = thresholds();
  const low = balances.filter(b => isLow(b, t, q)).map(b => ({ label: b.label, line: fmtBalance(b) }));
  try { writeFileSync(STAMP, JSON.stringify({ ts: Date.now(), low })); } catch {}
  return { low };
}
