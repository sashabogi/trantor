// The roster tab: filter pills, seat cards, Add a seat, Machines, Elsewhere (#13992).
import { useState } from "react";
import type { HubClient } from "../../../shared/api/client";
import type { Navigate } from "../../index";
import type { Crew } from "../Workspace/useCrew";
import { AddSeat } from "./AddSeat";
import { AgentCard } from "./AgentCard";
import { Elsewhere, Machines, SECTION_LABEL } from "./Machines";
import { applyFilters, chipForVendor, currentCard, levelFor, rosterSort, type Scope, type StateFilter } from "./model";
import type { AgentsData } from "./useAgentsData";
import type { OverseerData } from "./useOverseer";

const PILL = "rounded-full border px-2.5 py-1 text-v2-body";

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`${PILL} ${on ? "border-[var(--v2-accent)] bg-[var(--v2-accent-soft)] text-[var(--v2-text)]" : "border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-muted)]"}`}>{children}</button>
  );
}

export type RosterTabProps = { client: HubClient; project: string; data: AgentsData; ov: OverseerData; crew: Crew; onNavigate: Navigate };

export function RosterTab({ client, project, data, ov, crew, onNavigate }: RosterTabProps) {
  const [scope, setScope] = useState<Scope>("project");
  const [state, setState] = useState<StateFilter>("all");
  const shown = rosterSort(applyFilters(data.views, scope, project, state));
  const elsewhere = rosterSort(data.views.filter(v => v.project !== project && v.presence !== "offline"));
  const autonomy = ov.status?.autonomy ?? {};
  const toggle = (s: StateFilter) => setState(cur => (cur === s ? "all" : s));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill on={scope === "project"} onClick={() => setScope("project")}>This project</Pill>
        <Pill on={scope === "all"} onClick={() => setScope("all")}>All projects</Pill>
        <Pill on={state === "working"} onClick={() => toggle("working")}>Working</Pill>
        <Pill on={state === "needs-you"} onClick={() => toggle("needs-you")}>Needs you</Pill>
        <Pill on={state === "idle"} onClick={() => toggle("idle")}>Idle</Pill>
        <span className="flex-1" />
        <span className="text-v2-small text-[var(--v2-muted)]">sorted: needs you, working, ready</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5">
        {shown.map(v => (
          <AgentCard key={v.peer.session} client={client} view={v} card={currentCard(v.peer.session, data.cards)}
            plan={chipForVendor(v.vendor, data.balances.report)} level={levelFor(autonomy, v.project)} onNavigate={onNavigate}
            crew={v.project === project ? crew : undefined}
            duty={v.peer.session === ov.status?.dutySession ? { busy: ov.busy, start: ov.startDuty, stop: ov.stopDuty } : undefined} />
        ))}
      </div>
      {shown.length === 0 && <p className="m-0 text-v2-base text-[var(--v2-muted)]">No seats match this filter.</p>}
      <AddSeat report={data.balances.report} crew={crew} />
      <div className={SECTION_LABEL}>Machines</div>
      <Machines report={data.machines} views={data.views} />
      {scope === "project" && <>
        <div className={SECTION_LABEL}>Elsewhere · seats in other projects</div>
        <Elsewhere views={elsewhere} />
      </>}
    </div>
  );
}
