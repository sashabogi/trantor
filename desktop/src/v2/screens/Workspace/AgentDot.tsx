// The status dot of a sub-agent tab or tile: pulses while it runs, still under reduced motion through theme.css (#14265).
export function AgentDot({ running }: { running: boolean }) {
  return (
    <span role="img" aria-label={running ? "Running" : "Finished"} data-running={running || undefined}
      className={`h-[7px] w-[7px] shrink-0 rounded-full ${running ? "v2-agent-pulse bg-[var(--v2-ok)]" : "bg-[var(--v2-muted)]"}`} />
  );
}
