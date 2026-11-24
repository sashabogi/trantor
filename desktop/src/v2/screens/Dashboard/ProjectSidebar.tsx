// The Dashboard's project sidebar: Active now, Interrupted, Projects (#13986).
import { useMemo, useState } from "react";
import { Play, Search } from "lucide-react";
import { computeProjectActivity, activityLine, activityRank, activityTitle } from "../../../app/projectActivity";
import { orchestratorOpen, type RestorableSession } from "../../../features/workspace/herdr";
import { dismissedSessionsApi } from "../../../features/workspace/dismissedSessions";
import type { LocalSession, Peer } from "../../../shared/api/client";
import type { Navigate } from "../../routes";
import type { Interrupted } from "./useDashboardData";
import { ProjectTile } from "../../ui/ProjectTile";
import type { Presence } from "../../ui/identity";

type Props = {
  projects: string[]; open: LocalSession[]; peers: Peer[];
  interrupted: Interrupted;
  onNavigate: Navigate;
};

function Heading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--v2-muted)]">
      <span>{label}</span>{count !== undefined && <span className="v2-mono font-normal">{count}</span>}
    </div>
  );
}

const DOT = { "needs-you": "needs-you", working: "working", idle: "ready", unknown: "offline" } as const satisfies Record<string, Presence>;

export function ProjectSidebar({ projects, open, peers, interrupted, onNavigate }: Props) {
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const activity = useMemo(() => computeProjectActivity(open, peers), [open, peers]);
  const match = (p: string) => p.toLowerCase().includes(filter.trim().toLowerCase());
  const live = [...activity.keys()].filter(match).sort((a, b) => activityRank(activity.get(a)) - activityRank(activity.get(b)) || a.localeCompare(b));
  const rest = projects.filter(p => !activity.has(p) && match(p));
  const resume = async (project: string) => {
    setError("");
    try { await orchestratorOpen(project); interrupted.drop(project); }
    catch (e) { setError(`Could not resume ${project}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const dismiss = (r: RestorableSession) => {
    interrupted.drop(r.project);
    void dismissedSessionsApi.dismiss(r.project, r.sessionId).catch(() => {});
  };
  const row = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-[var(--v2-text-2)] v2-hover";
  return (
    <aside aria-label="Projects" className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-2 py-2.5">
      <label htmlFor="v2-dash-filter" className="sr-only">Filter projects</label>
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2 py-1.5">
        <Search size={13} aria-hidden className="text-[var(--v2-muted)]" />
        <input id="v2-dash-filter" value={filter} onChange={e => setFilter(e.target.value)} placeholder={`Filter ${projects.length} projects`}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      </div>
      {error && <p role="alert" className="m-0 px-2 pt-2 text-[11px] text-[var(--v2-bad)]">{error}</p>}
      <Heading label="Active now" count={live.length} />
      {live.map(p => {
        const act = activity.get(p);
        const line = activityLine(act);
        return (
          <button key={p} type="button" title={activityTitle(act)} onClick={() => onNavigate("workspace", p)} className={row}>
            <ProjectTile name={p} size={22} dot={act ? DOT[act.state] : undefined} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[var(--v2-text)]">{p}</span>
              {line && <span className={`block truncate text-[10.5px] ${line.tone === "warn" ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"}`}>{line.text}</span>}
            </span>
          </button>
        );
      })}
      {interrupted.rows.length > 0 && <Heading label="Interrupted" count={interrupted.rows.length} />}
      {interrupted.rows.map(r => (
        <div key={`${r.project}:${r.sessionId}`} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px]">
          <ProjectTile name={r.project} size={22} />
          <span className="min-w-0 flex-1 truncate text-[var(--v2-text-2)]">{r.project}</span>
          <button type="button" title="Resume this session" onClick={() => void resume(r.project)}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--v2-ok-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--v2-ok)]">
            <Play size={10} aria-hidden />Resume
          </button>
          <button type="button" aria-label={`Dismiss ${r.project}`} title="Dismiss: it stays wakeable from its project row" onClick={() => dismiss(r)}
            className="px-1 text-[13px] text-[var(--v2-muted)] hover:text-[var(--v2-text)]">×</button>
        </div>
      ))}
      <Heading label="Projects" />
      {rest.map(p => (
        <button key={p} type="button" onClick={() => onNavigate("workspace", p)} className={row}>
          <ProjectTile name={p} size={22} /><span className="min-w-0 flex-1 truncate">{p}</span>
        </button>
      ))}
      {rest.length === 0 && live.length === 0 && <p className="m-0 px-2 text-[11.5px] text-[var(--v2-muted)]">No projects match.</p>}
    </aside>
  );
}
