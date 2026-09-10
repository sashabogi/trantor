// A seat's ACTIVITY, resolved from one place (#5965): herdr's per-pane `agent_status` (screen
// detection, blind for RUNNER seats like kimi/glm) versus the hub peer status the runner itself
// registers (`working · <trigger>` / `idle` / `down:` / `errored:`). Trust herdr only when
// it actually looked; otherwise fall back to the hub status. Pure, unit-tested precedence.
export type SeatActivity = "working" | "blocked" | "idle" | "down";

export type HerdrAgentRow = {
  agent_status?: string | null;
  screen_detection_skipped?: boolean;
} | null | undefined;

/** Classify a hub-registered status string. The runner's vocabulary is `working · <trigger>`,
 *  `idle`, `down: <reason>`, `errored: <reason>`; older hub rows may carry `active in <proj>`. */
export function hubActivity(status: string | null | undefined): SeatActivity {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "idle";
  if (s.startsWith("working")) return "working";
  if (s.startsWith("blocked")) return "blocked";
  if (s.startsWith("down") || s.startsWith("errored")) return "down";
  return "idle";
}

/** herdr's per-pane agent_status vocabulary, mapped to the same SeatActivity. */
function herdrActivity(agentStatus: string | null | undefined): SeatActivity {
  const s = (agentStatus ?? "").trim().toLowerCase();
  if (s === "working" || s === "busy") return "working";
  if (s === "blocked") return "blocked";
  if (s.startsWith("down") || s.startsWith("errored")) return "down";
  return "idle";
}

/** The seat's activity, herdr-first with the hub status as fallback. herdr is only trusted when it
 *  genuinely observed the pane (has an agent_status and did NOT skip screen detection) — a runner
 *  seat reports screen_detection_skipped, so its herdr row is ignored and the hub status wins. */
export function seatActivity(herdrRow: HerdrAgentRow, hubStatus: string | null | undefined): SeatActivity {
  const trustedHerdr = herdrRow?.agent_status && !herdrRow.screen_detection_skipped;
  return trustedHerdr ? herdrActivity(herdrRow.agent_status) : hubActivity(hubStatus);
}
