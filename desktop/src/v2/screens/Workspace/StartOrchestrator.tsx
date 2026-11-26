// #14271: the chat panel's empty state when no orchestrator runs: one primary button on the shared wake.
import { Play } from "lucide-react";
import { CheckoutRecovery } from "../../ui/CheckoutRecovery";
import type { Navigate, WakeApi } from "../../routes";
import { Button } from "../../ui/Button";
import { wakeInFlight, wakeStatusLine } from "../Projects/wakeModel";

const TONE = { muted: "text-[var(--v2-muted)]", ok: "text-[var(--v2-ok)]", danger: "text-[var(--v2-bad)]" } as const;

export function StartOrchestrator({ project, wake, onNavigate }: { project: string; wake: WakeApi; onNavigate: Navigate }) {
  const state = wake.wakes.get(project);
  const flying = wakeInFlight(state);
  const line = flying ? { text: "Starting…", tone: "muted" as const } : wakeStatusLine(state);
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-lg border border-dashed border-[var(--v2-edge-2)] px-4 py-3.5">
      <p className="m-0 text-v2-base text-[var(--v2-muted)]">No orchestrator is running for this project.</p>
      <Button variant="primary" icon={<Play size={13} aria-hidden />} onClick={() => wake.start(project)}
        disabledReason={flying ? "The orchestrator is starting" : null}>
        {flying ? "Starting…" : "Start orchestrator"}
      </Button>
      {line?.text.toLowerCase().includes("no local checkout") && <CheckoutRecovery project={project} onNavigate={onNavigate} />}
      {line && <p role="status" className={`m-0 text-v2-body ${TONE[line.tone]}`}>{line.text}</p>}
    </div>
  );
}
