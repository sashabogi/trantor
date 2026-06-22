// trantor SessionStart balance check — the session env HAS the provider keys (the hub, under launchd,
// does not), so this is where we fetch prepaid credit, push a snapshot to the hub (for the dashboard),
// and surface a low-balance warning line. Throttled behind a 3h TTL stamp: most starts do ZERO network.
// Hard-capped at 4s so it can never noticeably slow a session start. Fail-silent by contract.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, isLow, fmtBalance, DEFAULT_LOW } from "../../lib/balances.mjs";

const STAMP = join(homedir(), ".agent-bus", "balances-check.json");
const TTL_MS = 3 * 3600 * 1000;
const CAP_MS = 4000;

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const u = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).url; if (u) return u; } catch {}
  return "http://127.0.0.1:4477";
}
function thresholds() {
  try { const lb = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).lowBalance; if (lb) return { ...DEFAULT_LOW, ...lb }; } catch {}
  return DEFAULT_LOW;
}

// Returns { low: [{label, line}], cached } — `low` is the list of providers below their refill threshold.
export async function maybeCheckBalances() {
  if (process.env.TRANTOR_NO_BALANCE_CHECK === "1") return { low: [] };
  let stamp = {}; try { stamp = JSON.parse(readFileSync(STAMP, "utf8")); } catch {}
  if (stamp.ts && Date.now() - stamp.ts < TTL_MS) return { low: stamp.low || [], cached: true };

  let balances;
  try { balances = await Promise.race([fetchBalances(process.env), new Promise((_, rej) => setTimeout(() => rej(new Error("cap")), CAP_MS))]); }
  catch { return { low: stamp.low || [] }; }   // timed out / errored — keep the last known low list, don't rewrite the stamp
  if (!Array.isArray(balances) || !balances.length) { try { writeFileSync(STAMP, JSON.stringify({ ts: Date.now(), low: [] })); } catch {} return { low: [] }; }

  // push the fresh snapshot to the hub for the dashboard + other sessions (best-effort)
  try {
    await fetch(`${relayUrl()}/balances`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances, ts: Date.now(), by: process.env.TRANTOR_SESSION || "" }), signal: AbortSignal.timeout(2000) });
  } catch {}

  const thr = thresholds();
  const low = balances.filter(b => isLow(b, thr)).map(b => ({ label: b.label, line: fmtBalance(b) }));
  try { writeFileSync(STAMP, JSON.stringify({ ts: Date.now(), low })); } catch {}
  return { low };
}
