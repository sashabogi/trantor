import { handoffStatusText, useHandoffState } from "./handoffState";

export function HandoffRecapStatus({ project, divider = false, error, busy = false }: {
  project: string; divider?: boolean; error?: string | null; busy?: boolean;
}) {
  const state = useHandoffState(project);
  const text = error ? `handoff failed · ${error}` : handoffStatusText(state) ?? (busy ? "handoff starting" : null);
  if (!text) return null;
  const failed = Boolean(error) || state?.state === "FAILED";
  return <span role="status" data-handoff-state={error ? "FAILED" : state?.state}
    title={text}
    className={`${divider ? "tr-mono px-3 py-1.5 text-[10.5px]" : "text-[10px] font-normal"} flex min-w-0 items-center gap-1.5 ${failed ? "text-tr-fail" : "text-tr-warn"}`}>
    <span className="tr-dot shrink-0" style={{ background: failed ? "var(--color-tr-fail)" : "var(--color-tr-warn)", width: 6, height: 6 }} />
    <span className="truncate">{text}</span>
  </span>;
}
