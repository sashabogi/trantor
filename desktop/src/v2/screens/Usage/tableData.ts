// The text cells of each table; the screen and the CSV export read the same rows (#13991).
import { fmtInt, fmtMoney, fmtPct } from "./format";
import type { AgentRow, CardRow, ProjectRow } from "./model";

export type TableData = { head: string[]; rows: string[][] };

export function agentTable(rows: AgentRow[]): TableData {
  return {
    head: ["AGENT", "VENDOR", "MODELS", "MACHINES", "TURNS", "WASTED TURNS", "WASTED %", "CARDS DONE"],
    rows: rows.map(r => [
      r.agent, r.vendor, r.models.filter(m => m !== "default").join(" ") || "cli-default", r.machines.join(" ") || "n/a",
      fmtInt(r.turns), fmtInt(r.failures), fmtPct(r.failures, r.turns), fmtInt(r.cardsDone),
    ]),
  };
}

export function cardTable(rows: CardRow[]): TableData {
  return {
    head: ["CARD", "TITLE", "OUTCOME", "SEAT", "MODEL", "COST"],
    rows: rows.map(r => [`#${r.id}`, r.title, r.status, r.seat || "n/a", r.model || "n/a", fmtMoney(r.cost)]),
  };
}

export function projectTable(rows: ProjectRow[]): TableData {
  return {
    head: ["PROJECT", "TURNS", "WASTED TURNS", "API VALUE (ALL TIME)"],
    rows: rows.map(r => [r.project, fmtInt(r.turns), fmtInt(r.failures), r.notional == null ? "n/a" : fmtMoney(r.notional)]),
  };
}
