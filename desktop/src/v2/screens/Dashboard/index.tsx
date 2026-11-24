// The 2.0 Dashboard: needs-you queue, working seats (list and grid), collisions, machines (#13986).
import { useMemo, useState } from "react";
import { orchestratorOpen } from "../../../features/workspace/herdr";
import { NotWired } from "../../shell/ClassicLenses";
import type { ScreenProps } from "../../routes";
import { Seg } from "../../ui/Seg";
import { buildQueue, liveSeats } from "./model";
import { NeedsYou } from "./NeedsYou";
import { Collisions, idleMoves, Machines, StatTiles, YourMove, type Move } from "./Panels";
import { ProjectSidebar } from "./ProjectSidebar";
import { useDashboardData } from "./useDashboardData";
import { useDecisions } from "./useDecisions";
import { WorkingNow } from "./WorkingNow";

type Layout = "overview" | "project" | "agent";
const LAYOUTS = [
  { value: "overview", label: "Overview" },
  { value: "project", label: "By project" },
  { value: "agent", label: "By agent" },
] as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DashboardScreen({ client, onNavigate }: ScreenProps) {
  const data = useDashboardData(client);
  const d = useDecisions(client);
  const [layout, setLayout] = useState<Layout>("overview");
  const queue = useMemo(
    () => buildQueue({ cards: data.cards, holds: data.holds, proposals: data.proposals, messages: data.messages, decided: d.decided }),
    [data.cards, data.holds, data.proposals, data.messages, d.decided]);
  const seats = useMemo(() => liveSeats(data.peers, data.cards), [data.peers, data.cards]);
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
  const working = seats.filter(s => s.presence === "working").length;
  return (
    <div className="flex h-full min-h-0">
      <ProjectSidebar projects={projects} open={data.open} peers={data.peers} interrupted={data.interrupted} onNavigate={onNavigate} />
      <main className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--v2-muted)]">Dashboard</h1>
            <p className="m-0 mt-1 text-[22px] font-[650] text-[var(--v2-text)]">
              {queue.length === 0 ? "Nothing needs you." : `${plural(queue.length, "thing needs", "things need")} you.`} {plural(working, "agent is", "agents are")} moving.
            </p>
          </div>
          <Seg label="Dashboard layout" value={layout} onChange={setLayout} options={LAYOUTS} />
        </div>
        {layout !== "overview" ? (
          <NotWired title={layout === "project" ? "By project" : "By agent"} line="This grouping is not wired yet. Overview shows every project and agent together." />
        ) : (
          <div className="flex flex-col gap-4">
            <StatTiles econ={data.econ} projects={projects.length} cards={data.cards.length} live={seats.length} />
            <NeedsYou items={queue} d={d} onNavigate={onNavigate} />
            <WorkingNow seats={seats} queue={queue} autonomy={autonomy} d={d} onNavigate={onNavigate} />
            <div className="grid grid-cols-2 gap-4">
              <YourMove moves={moves} />
              <Collisions holds={data.holds} d={d} />
            </div>
          </div>
        )}
      </main>
      <Machines report={data.machines} />
    </div>
  );
}
