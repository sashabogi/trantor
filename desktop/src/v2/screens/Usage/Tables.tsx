// By agent, by card and by project tables with CSV export (#13991).
import type { ReactNode } from "react";
import { Avatar, Button, Chip, Section, type ChipTone } from "../../index";
import { modelHue } from "../../ui/identity";
import { downloadCsv, toCsv } from "./format";
import type { AgentRow, CardRow, ProjectRow } from "./model";
import { agentTable, cardTable, projectTable, type TableData } from "./tableData";

const NUMERIC = /^(TURNS|WASTED|CARDS|COST|API)/;

function Grid({ data, cell, empty }: { data: TableData; cell?: (row: number, col: number) => ReactNode | undefined; empty: string }) {
  if (data.rows.length === 0) return <p className="m-0 px-[14px] py-3 text-v2-body text-[var(--v2-muted)]">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-v2-body">
        <thead><tr className="text-left text-v2-small tracking-[0.06em] text-[var(--v2-muted)]">
          {data.head.map(h => <th key={h} className={`px-3 py-2 font-semibold ${NUMERIC.test(h) ? "text-right" : ""}`}>{h}</th>)}
        </tr></thead>
        <tbody>{data.rows.map((r, i) => (
          <tr key={`${r[0]}-${i}`} className="border-t border-[var(--v2-edge)]">
            {r.map((text, c) => (
              <td key={data.head[c]} className={`px-3 py-[7px] ${NUMERIC.test(data.head[c]) ? "text-right tabular-nums" : ""}`}>
                {cell?.(i, c) ?? text}
              </td>))}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function ExportButton({ name, data }: { name: string; data: TableData }) {
  return <Button variant="ghost" onClick={() => downloadCsv(name, toCsv(data.head, data.rows))} disabledReason={data.rows.length ? null : "Nothing to export in this range"}>Export CSV</Button>;
}

export function AgentTable({ rows, agent, onAgent }: { rows: AgentRow[]; agent: string | null; onAgent: (a: string | null) => void }) {
  const data = agentTable(rows);
  return (
    <Section flush title="BY AGENT" sub="turns per agent kind from the hub's turn log; the hub does not serve a per-seat split or per-turn tokens"
      actions={<ExportButton name="usage-by-agent.csv" data={data} />}>
      <Grid data={data} empty="No turns recorded for this range and filter."
        cell={(i, c) => c !== 0 ? undefined : (
          <button type="button" aria-pressed={agent === rows[i].agent} onClick={() => onAgent(agent === rows[i].agent ? null : rows[i].agent)}
            className="inline-flex items-center gap-2 border-0 bg-transparent p-0 text-[var(--v2-text)]" title="Filter everything to this agent">
            <Avatar name={rows[i].agent} size={20} />{rows[i].agent}
            <span aria-hidden className="size-2 rounded-full" style={{ background: modelHue(rows[i].vendor) }} />
          </button>)} />
    </Section>
  );
}

const OUTCOME_TONE = { done: "ok", testing: "info", failed: "bad", blocked: "warn" } as const satisfies Record<string, ChipTone>;
const toneOf = (status: string): ChipTone => (status === "done" || status === "testing" || status === "failed" || status === "blocked" ? OUTCOME_TONE[status] : "neutral");

export function CardTable({ rows }: { rows: CardRow[] }) {
  const shown = rows.slice(0, 40);
  const data = cardTable(shown);
  return (
    <Section flush title="BY CARD" sub="cost of an outcome: only cards that carry a cost are listed"
      actions={<ExportButton name="usage-by-card.csv" data={data} />}>
      <Grid data={data} empty="No card carries a cost in this range."
        cell={(i, c) => {
          const r = shown[i];
          if (c === 0) return <span className="v2-mono text-[var(--v2-accent)]">#{r.id}</span>;
          if (c === 2) return <Chip tone={toneOf(r.status)}>{r.status}</Chip>;
          return undefined;
        }} />
    </Section>
  );
}

export function ProjectTable({ rows, project, onProject }: { rows: ProjectRow[]; project: string | null; onProject: (p: string | null) => void }) {
  const data = projectTable(rows);
  return (
    <Section flush title="BY PROJECT" sub="click one to filter everything" actions={<ExportButton name="usage-by-project.csv" data={data} />}>
      <Grid data={data} empty="No project has turns in this range."
        cell={(i, c) => c !== 0 ? undefined : (
          <button type="button" aria-pressed={project === rows[i].project} onClick={() => onProject(project === rows[i].project ? null : rows[i].project)}
            className="border-0 bg-transparent p-0 text-left text-[var(--v2-text)] hover:text-[var(--v2-accent-hi)]">{rows[i].project}</button>)} />
    </Section>
  );
}
