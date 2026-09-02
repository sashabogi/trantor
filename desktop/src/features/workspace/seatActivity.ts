// A seat's ACTIVITY, resolved from one place (#5965). The workspace seat tabs and the sidebar
// project rows ask "is this seat working right now?", and two sources answer:
//
//   • the herdr per-pane agent row (`agent_status`, plus whether herdr could even screen-detect the
//     pane). herdr sees an INTERACTIVE seat mid-turn and says "working"; for a RUNNER-driven seat
//     (kimi, glm, …) herdr skips screen detection, so its row never leaves "idle" while the seat
//     is genuinely turning.
//   • the hub peer status the runner registers. The runner is the only process that KNOWS a turn
//     started, so #5965 makes it the source of truth: `working · <trigger>` at turn start, `idle`
//     at turn end, `down:` / `errored:` on failure.
//
// The rule: trust herdr when it actually looked (agent_status present AND screen detection not
// skipped); otherwise FALL BACK to the hub status. Pure, so the whole precedence is unit-tested.
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
