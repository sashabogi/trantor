// The autonomy ladder for the active project, with one-rung +/- through client.setAutonomy (#13992).
import { Minus, Plus } from "lucide-react";
import type { HubClient } from "../../../shared/api/client";
import { LEVEL_LABEL } from "../../../features/overseer/model";
import { dictGet } from "../../../shared/dict";
import { IconButton } from "../../index";
import type { Action } from "./useOverseer";
import { SECTION_LABEL } from "./Machines";

const RUNGS = [1, 2, 3, 4] as const;
const MIN = RUNGS[0];
const MAX = RUNGS[RUNGS.length - 1];

export type AutonomyLadderProps = {
  client: HubClient;
  project: string;
  level: number;
  busy: boolean;
  /** Runs the write through the column's busy/notice/refresh wrapper. */
  run: (action: Action) => Promise<void>;
};

export function AutonomyLadder({ client, project, level, busy, run }: AutonomyLadderProps) {
  const set = (n: number) => void run(() => client.setAutonomy(project, n).then(() => `${project} autonomy set to ${n}`));
  const noProject = !project;
  return (
    <section aria-label="Autonomy ladder" className="rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={`${SECTION_LABEL} flex-1`}>Autonomy ladder{project ? ` · ${project}` : ""}</span>
        <IconButton label="Lower one rung" title={level <= MIN ? "Already at the lowest rung" : "Lower one rung"} size={24} variant="outline"
          disabled={busy || noProject || level <= MIN} onClick={() => set(level - 1)}><Minus size={12} /></IconButton>
        <IconButton label="Raise one rung" title={level >= MAX ? "Already at the highest rung" : "Raise one rung"} size={24} variant="outline"
          disabled={busy || noProject || level >= MAX} onClick={() => set(level + 1)}><Plus size={12} /></IconButton>
      </div>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {RUNGS.map(n => (
          <li key={n} aria-current={n === level ? "step" : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12px] ${n === level ? "bg-[var(--v2-accent-soft)]" : ""}`}>
            <span className="v2-mono w-4 text-[var(--v2-muted)]">{n}</span>
            <span className="flex-1 capitalize">{dictGet(LEVEL_LABEL, String(n))}</span>
            {n === level && <span className="text-[10.5px] font-semibold text-[var(--v2-accent-hi)]">now</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
