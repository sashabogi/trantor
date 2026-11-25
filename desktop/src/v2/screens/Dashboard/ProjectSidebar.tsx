// The Dashboard's project sidebar: Active now, Interrupted, Projects (#13986).
import { useMemo, useState, type ReactNode } from "react";
import { Play, Plus, Search } from "lucide-react";
import { computeProjectActivity, activityLine, activityRank, activityTitle } from "../../../app/projectActivity";
import { orchestratorOpen, type RestorableSession } from "../../../features/workspace/herdr";
import { dismissedSessionsApi } from "../../../features/workspace/dismissedSessions";
import type { Card, LocalSession, Peer } from "../../../shared/api/client";
import type { Navigate } from "../../routes";
import { landingLens } from "../../shell/shellMode";
import type { Interrupted } from "./useDashboardData";
import { ProjectTile } from "../../ui/ProjectTile";
import type { Presence } from "../../ui/identity";
import { activeProjects } from "./model";

const SHOW_ALL_KEY = "trantor.v2.dashboard.projects.show-all";
function savedShowAll(): boolean {
  try { return localStorage.getItem(SHOW_ALL_KEY) === "true"; } catch { return false; }
}

type Props = {
  projects: string[]; cards: Card[]; open: LocalSession[]; peers: Peer[];
  interrupted: Interrupted;
  onNavigate: Navigate;
  onStartProject?: () => void;
};

function Heading({ label, count, action }: { label: string; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-v2-micro font-semibold uppercase tracking-[0.12em] text-[var(--v2-muted)]">
      <span>{label}</span>{count !== undefined && <span className="v2-mono font-normal">{count}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

const DOT = { "needs-you": "needs-you", working: "working", idle: "ready", unknown: "offline" } as const satisfies Record<string, Presence>;

export function ProjectSidebar({ projects, cards, open, peers, interrupted, onNavigate, onStartProject }: Props) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(savedShowAll);
  const [error, setError] = useState("");
  const activity = useMemo(() => computeProjectActivity(open, peers), [open, peers]);
  const active = useMemo(() => activeProjects(projects, cards, activity.keys()), [projects, cards, activity]);
  const match = (p: string) => p.toLowerCase().includes(filter.trim().toLowerCase());
  const live = [...activity.keys()].filter(match).sort((a, b) => activityRank(activity.get(a)) - activityRank(activity.get(b)) || a.localeCompare(b));
  const rest = projects.filter(p => !activity.has(p) && active.has(p) && match(p));
  const inactive = projects.filter(p => !activity.has(p) && !active.has(p) && match(p));
  const shownRest = showAll || filter.trim() ? [...rest, ...inactive] : rest;
  const toggleAll = () => {
    const next = !showAll;
    setShowAll(next);
    try { localStorage.setItem(SHOW_ALL_KEY, String(next)); } catch { /* storage blocked: keep the session choice */ }
  };
  const resume = async (project: string) => {
    setError("");
    try { await orchestratorOpen(project); interrupted.drop(project); }
    catch (e) { setError(`Could not resume ${project}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const dismiss = (r: RestorableSession) => {
    interrupted.drop(r.project);
    void dismissedSessionsApi.dismiss(r.project, r.sessionId).catch(() => {});
  };
  const row = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-v2-base text-[var(--v2-text-2)] v2-hover";
  return (
    <aside aria-label="Projects" className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-2 py-2.5">
      <label htmlFor="v2-dash-filter" className="sr-only">Filter projects</label>
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2 py-1.5">
        <Search size={13} aria-hidden className="text-[var(--v2-muted)]" />
        <input id="v2-dash-filter" value={filter} onChange={e => setFilter(e.target.value)} placeholder={`Filter ${projects.length} projects`}
          className="min-w-0 flex-1 bg-transparent text-v2-body text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      </div>
      {error && <p role="alert" className="m-0 px-2 pt-2 text-v2-small text-[var(--v2-bad)]">{error}</p>}
      <Heading label="Active now" count={live.length} />
      {live.map(p => {
        const act = activity.get(p);
        const line = activityLine(act);
        return (
          <button key={p} type="button" title={activityTitle(act)} onClick={() => onNavigate(landingLens(), p)} className={row}>
            <ProjectTile name={p} size={22} dot={act ? DOT[act.state] : undefined} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[var(--v2-text)]">{p}</span>
              {line && <span className={`block truncate text-v2-small ${line.tone === "warn" ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"}`}>{line.text}</span>}
            </span>
          </button>
        );
      })}
      {interrupted.rows.length > 0 && <Heading label="Interrupted" count={interrupted.rows.length} />}
      {interrupted.rows.map(r => (
        <div key={`${r.project}:${r.sessionId}`} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-v2-base">
          <ProjectTile name={r.project} size={22} />
          <span className="min-w-0 flex-1 truncate text-[var(--v2-text-2)]">{r.project}</span>
          <button type="button" title="Resume this session" onClick={() => void resume(r.project)}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--v2-ok-soft)] px-1.5 py-0.5 text-v2-small font-semibold text-[var(--v2-ok)]">
            <Play size={10} aria-hidden />Resume
          </button>
          <button type="button" aria-label={`Dismiss ${r.project}`} title="Dismiss: it stays wakeable from its project row" onClick={() => dismiss(r)}
            className="px-1 text-v2-base text-[var(--v2-muted)] hover:text-[var(--v2-text)]">×</button>
        </div>
      ))}
      <Heading label="Projects" action={onStartProject && (
        <button type="button" aria-label="Start a project" title="Start a project (⌘N)" onClick={onStartProject}
          className="v2-hover inline-flex rounded-md border-0 bg-transparent p-0.5 text-[var(--v2-muted)]">
          <Plus size={13} aria-hidden />
        </button>
      )} />
      {shownRest.map(p => (
        <button key={p} type="button" onClick={() => onNavigate(landingLens(), p)} className={row}>
          <ProjectTile name={p} size={22} /><span className="min-w-0 flex-1 truncate">{p}</span>
        </button>
      ))}
      {!filter.trim() && inactive.length > 0 && (
        <button type="button" onClick={toggleAll} className="mt-1 rounded-lg px-2 py-1.5 text-left text-v2-body text-[var(--v2-muted)] v2-hover">
          {showAll ? "Show fewer projects" : `Show all ${inactive.length}`}
        </button>
      )}
      {!projects.some(match) && live.length === 0 && <p className="m-0 px-2 text-v2-body text-[var(--v2-muted)]">No projects match.</p>}
    </aside>
  );
}
