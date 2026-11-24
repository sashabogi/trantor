// #14030: agent CLI compatibility for the 2.0 shell — one fetch at mount (monitoring doctrine:
// state, not events, no nagging), plus the feature gate a surface uses to ask whether a
// version-dependent feature (e.g. the Mode menu) is inside its verified range.
import { useEffect, useState } from "react";
import { agentCliCompatibility, type AgentCliCompatibility } from "../../shared/api/client";

/** The compatibility rows, read once per mount; empty until the Rust side answers. */
export function useAgentCliCompatibility(): AgentCliCompatibility[] {
  const [reports, setReports] = useState<AgentCliCompatibility[]>([]);
  useEffect(() => {
    let alive = true;
    void agentCliCompatibility().then(found => { if (alive) setReports(found); }).catch(() => {});
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
