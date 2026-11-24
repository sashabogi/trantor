// #14030: agent CLI compatibility for the 2.0 shell — one fetch at mount (monitoring doctrine:
// state, not events, no nagging), plus the feature gate a surface uses to ask whether a
// version-dependent feature (e.g. the Mode menu) is inside its verified range.
import { useEffect, useState } from "react";
import { agentCliCompatibility, agentCliStaleSessions, agentCliUpdate, type AgentCliCompatibility, type AgentCliStaleSessions, type AgentCliUpdate } from "../../shared/api/client";

/** The compatibility rows, read once per mount; empty until the Rust side answers. */
export function useAgentCliCompatibility(): AgentCliCompatibility[] {
  const [reports, setReports] = useState<AgentCliCompatibility[]>([]);
  useEffect(() => {
    let alive = true;
    // An app whose native side does not answer with rows must still open: no rows means no banner.
    void agentCliCompatibility().then(found => { if (alive && Array.isArray(found)) setReports(found); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return reports;
}

// Feature gate (#14030): can a surface rely on a version-dependent feature? Outside its verified
// range the caller shows the feature's honest unavailable state (e.g. "Mode unknown") instead of
// misbehaving; not installed or unreadable is never in range.
export function featureInRange(reports: AgentCliCompatibility[], feature: string, cli = "claude"): boolean {
  return reports.some(r => r.cli === cli && r.features.some(f => f.name === feature && f.inRange));
}

/** #14030: a version as comparable parts; null when it does not parse — never guessed. */
function versionParts(v: string | null): [number, number, number] | null {
  const parts = (v ?? "").trim().split(".").map(p => Number(p));
  return parts.length >= 3 && parts.every(p => Number.isInteger(p) && p >= 0)
    ? [parts[0], parts[1], parts[2]]
    : null;
}

export type FeatureRange = {
  /** below | in | above the feature's verified range; "unknown" never gates anything (#14030). */
  verdict: "below" | "in" | "above" | "unknown";
  installed: string | null;
  verifiedFrom: string | null;
  verifiedTo: string | null;
};

/** The Mode menu's gate (#14030): the feature's range as below / in / above plus the versions, so
 * the surface can name them. No rows, no feature or an unreadable version answers "unknown" — the
 * closed-loop read stays the guard, exactly as before. */
export function featureRange(reports: AgentCliCompatibility[], feature: string, cli = "claude"): FeatureRange {
  const row = reports.find(r => r.cli === cli);
  const f = row?.features.find(f => f.name === feature);
  const installed = versionParts(row?.installed ?? null);
  const from = versionParts(f?.verifiedFrom ?? null);
  const to = versionParts(f?.verifiedTo ?? null);
  if (!f || !installed || !from || !to) {
    return { verdict: "unknown", installed: row?.installed ?? null, verifiedFrom: f?.verifiedFrom ?? null, verifiedTo: f?.verifiedTo ?? null };
  }
  const cmp = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const verdict = cmp(installed, from) < 0 ? "below" : cmp(installed, to) > 0 ? "above" : "in";
  return { verdict, installed: row?.installed ?? null, verifiedFrom: f.verifiedFrom, verifiedTo: f.verifiedTo };
}

/** #14030: the sessions still on the old binary, read once per mount and again after a refresh
 * key moves (the update click). A native side that answers nothing claims nothing. */
export function useAgentCliStaleSessions(cli: string, refreshKey = 0): AgentCliStaleSessions | null {
  const [report, setReport] = useState<AgentCliStaleSessions | null>(null);
  useEffect(() => {
    let alive = true;
    void agentCliStaleSessions(cli).then(found => {
      if (alive && found && Array.isArray(found.rows)) setReport(found);
    }).catch(() => {});
    return () => { alive = false; };
  }, [cli, refreshKey]);
  return report;
}

export type AgentCliUpdateState = {
  busy: boolean;
  result: AgentCliUpdate | null;
  /** Runs the CLI's own updater — only ever called from the operator's click (#14030). */
  run: () => void;
};

/** #14030: the update click's state machine for one CLI, shared by the banner and About. */
export function useAgentCliUpdate(cli: string): AgentCliUpdateState {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentCliUpdate | null>(null);
  const run = () => {
    if (busy) return;
    setBusy(true);
    void agentCliUpdate(cli)
      .then(r => setResult(r))
      .catch(e => setResult({ ok: false, before: null, after: null, output: String(e) }))
      .finally(() => setBusy(false));
  };
  return { busy, result, run };
}
