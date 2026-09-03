// trantor seat-why — diagnose a crew seat from local ~/.agent-bus evidence, no hub required.
//
// Given (project, agent), reads the same evidence a human operator would, in this order:
//   1. err-<agent>-<proj>.txt FIRST — the last turn's CLI output, where auth/quota markers live
//   2. logs/<agent>-<proj>.jsonl — the runner's telemetry (turns, exit codes, authFailed)
//   3. crew-windows.txt — which terminal pane the seat was supposed to own
//   4. live crew-runner processes for this agent+project
// Returns { state, why, advice } where state is one of live | dead-quota | dead-auth |
// dead-crash | no-runner | no-pane.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");

// Same vocabulary crew-runner.mjs's classifyFailure uses, so seat-why and the runner agree on
// what "quota" and "auth" look like in a turn's output.
const QUOTA_RE = /quota|insufficient|credit|balance|payment required|402|429|too many requests|rate.?limit|exceeded your|reached your [^.\n]*limit|usage limit|key limit exceeded|monthly limit|limit exceeded|out of (credit|quota)/i;
const AUTH_RE = /unauthor|401|403|forbidden|invalid[ _-]?api[ _-]?key|authentication? failed|token expired/i;

const readF = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

function readTelemetry(file) {
  const out = [];
  for (const line of readF(file).split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === "object") out.push(r); } catch {}
  }
  return out;
}

function findPane(dir, project, agent) {
  const row = readF(join(dir, "crew-windows.txt")).split("\n")
    .map(l => l.split("\t"))
    .filter(c => c.length >= 4 && c[0] === project && c[2] === agent)
    .pop();
  return row ? { source: row[1], agent: row[2], pane: row[3] } : null;
}

// A seat is "live" iff a crew-runner process for this agent+project exists. pgrep matches the
// runner by its CLI arg (`crew-runner.mjs <agent>`); the RELAY_PROJECT env, visible via `ps eww`,
// disambiguates projects that happen to share an agent name. Empty on any error (ps/pgrep absent).
function scanPids(project, agent) {
  try {
    const raw = execSync(`pgrep -f "crew-runner.mjs ${agent}"`, { encoding: "utf8", timeout: 5000 }).trim();
    if (!raw) return [];
    const projRe = new RegExp(`RELAY_PROJECT=${project}(\\s|$)`);
    return raw.split("\n").filter(Boolean).filter((pid) => {
      try { return projRe.test(execSync(`ps eww -p ${pid} -o command=`, { encoding: "utf8", timeout: 5000 }).trim()); }
      catch { return false; }
    }).map(Number);
  } catch { return []; }
}

const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return String(ts); } };
const rel = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// What this seat has SPENT today (#6134). The turn count is the number that mattered on 09-02:
// 151 turns and ~16 agentic hours across the fleet, most of it redelivery and coordination noise.
// Tokens come from each CLI's own usage line (the runner parses it onto the turn's row); CLIs that
// print none contribute 0, which is why the count is reported alongside — "3 of 7 turns reported".
export function todaySpend(telemetry, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const rows = telemetry.filter(r => typeof r.turn === "number" && r.ts >= midnight.getTime());
  const withTokens = rows.filter(r => Number(r.tokens) > 0);
  return {
    turns: rows.length,
    minutes: Math.round(rows.reduce((a, r) => a + (Number(r.duration_ms) || 0), 0) / 60000),
    tokens: withTokens.reduce((a, r) => a + Number(r.tokens), 0),
    reported: withTokens.length,
    cut: rows.filter(r => r.cut).length,
  };
}

export function fmtSpend(s) {
  const bits = [`${s.turns} turn${s.turns === 1 ? "" : "s"}`, `${s.minutes}m`];
  bits.push(s.reported
    ? `${s.tokens.toLocaleString("en-US")} tokens (${s.reported}/${s.turns} turns reported)`
    : "tokens not reported by this CLI");
  if (s.cut) bits.push(`${s.cut} cut at the time box`);
  return bits.join(" · ");
}

export function seatWhy(project, agent, opts = {}) {
  const dir = opts.dir || busDir();
  const errText = readF(join(dir, `err-${agent}-${project}.txt`));
  const telemetry = readTelemetry(join(dir, "logs", `${agent}-${project}.jsonl`));
  const pane = findPane(dir, project, agent);
  const pids = opts.pidCheck ? opts.pidCheck(project, agent) : scanPids(project, agent);
  const last = [...telemetry].reverse().find(r => typeof r.turn === "number") || null;
  const boots = telemetry.filter(r => r.boot).length;
  const errTail = errText.trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 240);

  let state, why, advice;

  if (pids.length) {
    const pidList = pids.join(", ");
    if (!pane) {
      state = "no-pane";
      why = `crew-runner pid ${pidList} alive for ${agent}:${project}, but crew-windows.txt has no pane row — the seat is headless.`;
      advice = "give the seat a window it can be read in: `trantor up <agent>` (or attach via herdr/cmux).";
    } else {
      const health = last
        ? (last.effExit || last.exit)
          ? `last turn ${rel(last.ts)} (${last.trigger}) FAILED (exit ${last.effExit ?? last.exit}${last.authFailed ? ", auth" : ""})`
          : `last turn ${rel(last.ts)} (${last.trigger}) clean (exit 0)`
        : `no completed turn yet (${boots} boot record${boots === 1 ? "" : "s"})`;
      state = "live";
      why = `crew-runner pid ${pidList} alive, pane ${pane.source}/${pane.pane}; ${health}.`;
      advice = last && (last.effExit || last.exit)
        ? `seat is up but its last turn failed${last.authFailed ? " — auth: check the provider key" : ""}. Watch it or swap.`
        : "seat is healthy — nothing to do.";
    }
  } else {
    const bits = [];
    if (errText.trim()) bits.push(`err-${agent}-${project}.txt: ${errTail || "(empty)"}`);
    if (last) bits.push(`last turn ${rel(last.ts)} (${last.trigger}) exit ${last.effExit ?? last.exit}${last.authFailed ? " · authFailed" : ""}`);
    else if (boots) bits.push(`${boots} boot record(s), no completed turn`);
    if (pane) bits.push(`pane ${pane.source}/${pane.pane} registered but no runner process`);

    if (last?.authFailed || AUTH_RE.test(errText)) {
      state = "dead-auth";
      why = `no runner process; ${bits.join("; ") || "auth markers in evidence"}.`;
      advice = "provider credentials are rejected — fix the key (~/.agent-bus/.env or the seat's token-scrooge .env), then `trantor up <agent>`.";
    } else if (QUOTA_RE.test(errText)) {
      state = "dead-quota";
      why = `no runner process; ${bits.join("; ") || "quota markers in evidence"}.`;
      advice = "credits/balance exhausted — `trantor swap <agent>` to a provider with balance.";
    } else if (last || errText.trim()) {
      state = "dead-crash";
      why = `no runner process; ${bits.join("; ") || "evidence present"}.`;
      advice = "runner died unexpectedly — review err-<agent>-<proj>.txt, then `trantor up <agent>` (or `trantor swap` if it crash-loops).";
    } else {
      state = "no-runner";
      why = `no runner pid, no err-${agent}-${project}.txt, no telemetry${pane ? ", a pane row exists but the seat never started" : " and no pane row"} — the seat has never run on this machine.`;
      advice = "`trantor up <agent>` to start the seat.";
    }
  }

  return { state, why, advice, today: todaySpend(telemetry, opts.now) };
}

export { fmt, rel };
