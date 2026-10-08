import { handoffWaiting, useHandoffState } from "./handoffState";

export function HandoffRecapStatus({ project, divider = false }: { project: string; divider?: boolean }) {
  const state = useHandoffState(project);
  if (!handoffWaiting(state)) return null;
  return <span role="status" data-handoff-state={state?.state}
    className={divider ? "tr-mono my-2 block text-center text-[10.5px] text-tr-warn" : "block truncate text-[10px] font-normal text-tr-warn"}>
    handoff waiting for recap
  </span>;
}
