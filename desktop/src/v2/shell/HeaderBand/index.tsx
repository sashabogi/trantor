// #14256: the project header keeps purpose, activity, health and decisions in one row.
import type { HubClient } from "../../../shared/api/client";
import type { Navigate } from "../../routes";
import { PhaseGoal } from "./PhaseGoal";
import { SeatLanes } from "./SeatLanes";
import { MainHealth } from "./MainHealth";
import { NeedsYou } from "./NeedsYou";
import { useHealthData, useLaneData, useNeedsData, usePhaseData } from "./useBandData";

export function HeaderBand({ client, project, onNavigate }: { client: HubClient; project: string; onNavigate: Navigate }) {
  const phases = usePhaseData(client, project);
  const lanes = useLaneData(client, project);
  const health = useHealthData(project);
  const ids = useNeedsData(client, project);
  return (
    <div className="v2-header-band flex h-full min-w-0 flex-1 items-stretch gap-2" aria-label="Project overview">
      <PhaseGoal data={phases} onOpen={() => onNavigate("board", project)} />
      <SeatLanes project={project} {...lanes} onOpen={() => onNavigate("workspace", project)} />
      <MainHealth {...health} />
      <NeedsYou key={project} ids={ids} onOpen={() => onNavigate("inbox", project)} />
    </div>
  );
}
