import type { FileHold, ProjectPhase, Proposal, TurnRow } from "../../../shared/api/client";

export function turn(overrides: Partial<TurnRow> = {}): TurnRow {
  return { id: "t1", v: 1, ts: 3_000_000, persona: "codex-8", agent: "codex", project: "trantor", machine: "local",
    turn: 1, trigger: "card", card: 14256, model: "gpt", duration_ms: 600_000, tokens: null, exit: 0, effExit: 0,
    outcome: "completed", verdict: "ok", ...overrides };
}

export function phase(key: string, statuses: string[], goal = ""): ProjectPhase {
  return { key, goal, crew: statuses.map((status, id) => ({ id, title: `Card ${id}`, status })), orchestrators: [] };
}

export function proposal(id: number, project = "trantor"): Proposal {
  return { id, project, session: "codex:trantor", scope: "edit", condition: "tests", exclusions: "none", status: "pending", ts: 1 };
}

export function hold(id: number, project = "trantor"): FileHold {
  return { id, project, session: "codex:trantor", other: "kimi:trantor", file: "a.ts", status: "pending", ts: 1 };
}

