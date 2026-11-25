// Cache ratios and failed-turn counts read from the hub (#13991).
import { NotWired, Section } from "../../index";
import type { BalanceRow } from "../../../features/fleet/balanceChips";
import { fmtInt, fmtPct } from "./format";
import type { AgentStat } from "./model";

export function CachePanel({ rows }: { rows: BalanceRow[] }) {
  const withCache = rows.filter(r => r.promptCache?.hitRatio != null);
  return (
    <Section title="CACHE AND CONTEXT" sub="the prompt cache as Claude Code reports it">
      {withCache.length === 0
        ? <NotWired title="No cache stats yet" line="Claude Code has not reported a prompt-cache ratio to the hub; per-seat context use is not served either." />
        : withCache.map(r => {
          const pc = r.promptCache;
          return (
            <div key={r.provider} data-cache={r.provider} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-v2-heading font-semibold">{Math.round((pc?.hitRatio ?? 0) * 100)}%</span>
              <span className="text-v2-body text-[var(--v2-muted)]">
                {r.label ?? r.provider} prompt cache hit · {pc?.warm ? "warm" : "cold"}
                {pc?.misses != null ? ` · ${fmtInt(pc.misses)} misses` : ""}
                {!pc?.warm && pc?.lastMissCause ? ` · last miss: ${pc.lastMissCause.replace(/_/g, " ")}` : ""}
              </span>
            </div>
          );
        })}
    </Section>
  );
}

export function WastedPanel({ stats }: { stats: AgentStat[] }) {
  const rows = stats.filter(a => a.failures > 0);
  return (
    <Section title="WASTED TURNS" sub="turns that ended in an error, per agent">
      {rows.length === 0 && <p className="m-0 text-v2-body text-[var(--v2-muted)]">{stats.length ? "No failed turns in this range." : "No turns in this range."}</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(a => (
          <li key={a.agent} className="flex items-center gap-3 text-v2-body">
            <span className="w-[110px] truncate">{a.agent}</span>
            <span className="h-[6px] flex-1 overflow-hidden rounded-sm bg-[var(--v2-edge)]">
              <span className="block h-[6px] bg-[var(--v2-warn)]" style={{ width: `${Math.min(100, (a.failures / a.turns) * 100)}%` }} />
            </span>
            <span className="w-[96px] text-right tabular-nums text-[var(--v2-text-2)]">{fmtInt(a.failures)} · {fmtPct(a.failures, a.turns)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
