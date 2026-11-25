// The 2.0 Dashboard: needs-you queue, working seats (list and grid), collisions, machines (#13986).
import { useMemo, useState } from "react";
import { computeProjectActivity } from "../../../app/projectActivity";
import { orchestratorOpen } from "../../../features/workspace/herdr";
import type { ScreenProps } from "../../routes";
import { Seg } from "../../ui/Seg";
import { actionableCount, buildQueue, dashboardGroups, liveSeats } from "./model";
import { NeedsYou } from "./NeedsYou";
import { Collisions, idleMoves, Machines, StatTiles, YourMove, type Move } from "./Panels";
import { ProjectSidebar } from "./ProjectSidebar";
import { useDashboardData } from "./useDashboardData";
import { useDecisions } from "./useDecisions";
import { WorkingNow } from "./WorkingNow";
import { StartCard } from "../Projects/StartCard";

type Layout = "overview" | "project" | "agent";
const LAYOUT_KEY = "trantor.v2.dashboard.layout";
const LAYOUTS = [
  { value: "overview", label: "Overview" },
  { value: "project", label: "By project" },
  { value: "agent", label: "By agent" },
] as const;

function savedLayout(): Layout {
  try {
    const value = localStorage.getItem(LAYOUT_KEY);
    return value === "project" || value === "agent" ? value : "overview";
  } catch { return "overview"; }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DashboardScreen({ client, onNavigate, onStartProject }: ScreenProps) {
  const data = useDashboardData(client);
  const d = useDecisions(client);
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const queue = useMemo(
    () => buildQueue({ cards: data.cards, holds: data.holds, proposals: data.proposals, messages: data.messages, allMessages: data.allMessages, decided: d.decided }),
    [data.cards, data.holds, data.proposals, data.messages, data.allMessages, d.decided]);
  const activity = useMemo(() => computeProjectActivity(data.open, data.peers), [data.open, data.peers]);
  const seats = useMemo(() => liveSeats(data.peers, data.cards, undefined, activity), [data.peers, data.cards, activity]);
  const groups = useMemo(() => layout === "overview" ? [] : dashboardGroups(layout, queue, seats), [layout, queue, seats]);
  const autonomy = useMemo(() => new Map(Object.entries(data.overseer?.autonomy ?? {})), [data.overseer]);
  const projects = useMemo(
    () => [...new Set([...data.known, ...data.cards.map(c => c.project).filter(Boolean)])].sort(),
    [data.known, data.cards]);
  const moves: Move[] = [
    ...data.interrupted.rows.map(r => ({
      key: `resume:${r.project}`, project: r.project, title: `Resume ${r.project}`, sub: "session died with the machine", action: "Resume",
      go: () => { void orchestratorOpen(r.project).then(() => data.interrupted.drop(r.project)).catch(() => {}); },
    })),
    ...idleMoves(seats, onNavigate),
  ];
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* storage blocked: keep the session choice */ }
  };
  const working = seats.filter(s => s.presence === "working").length;
  const actionable = actionableCount(queue);
  if (data.knownLoaded && projects.length === 0) return <StartCard onStart={onStartProject} />;
  return (
    <div className="flex h-full min-h-0">
      <ProjectSidebar projects={projects} cards={data.cards} open={data.open} peers={data.peers} interrupted={data.interrupted} onNavigate={onNavigate} onStartProject={onStartProject} />
      <main className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-v2-small font-semibold uppercase tracking-[0.12em] text-[var(--v2-muted)]">Dashboard</h1>
            <p className="m-0 mt-1 text-v2-heading font-[650] text-[var(--v2-text)]">
              {actionable === 0 ? "Nothing needs you." : `${plural(actionable, "thing needs", "things need")} you.`} {plural(working, "agent is", "agents are")} moving.
            </p>
          </div>
          <Seg label="Dashboard layout" value={layout} onChange={chooseLayout} options={LAYOUTS} />
        </div>
        <div className="flex flex-col gap-4">
          <StatTiles econ={data.econ} projects={projects.length} cards={data.cards.length} live={seats.length} />
          {layout === "overview" ? (
            <>
              <NeedsYou items={queue} d={d} onNavigate={onNavigate} />
              <WorkingNow seats={seats} queue={queue} autonomy={autonomy} d={d} onNavigate={onNavigate} />
            </>
          ) : groups.map(group => (
            <section key={group.key} aria-label={group.label} className="flex flex-col gap-3">
              <h2 className="m-0 text-v2-title font-semibold text-[var(--v2-text)]">{group.label}</h2>
              {group.items.length > 0 && <NeedsYou items={group.items} d={d} onNavigate={onNavigate} />}
              {group.seats.length > 0 && <WorkingNow seats={group.seats} queue={queue} autonomy={autonomy} d={d} onNavigate={onNavigate} />}
            </section>
          ))}
          <div className="grid grid-cols-2 gap-4">
            <YourMove moves={moves} />
            <Collisions holds={data.holds} d={d} />
          </div>
        </div>
      </main>
      <Machines report={data.machines} />
    </div>
  );
}
