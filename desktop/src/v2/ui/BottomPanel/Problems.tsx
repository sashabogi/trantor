// On demand project checks, grouped by file; no process starts until Run is pressed (#14086).
import { invoke } from "@tauri-apps/api/core";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ProblemCheck = { id: string; label: string; kind: "typescript" | "rust"; directory: string };
export type ProblemItem = {
  path: string; line: number; column: number; severity: "error" | "warning"; code: string; message: string;
};
export type ProblemRun = {
  items: ProblemItem[]; exitCode: number | null; durationMs: number; raw: string[]; timedOut: boolean;
};
export type ProblemGroup = { path: string; items: ProblemItem[]; errors: number; warnings: number };

const count = (items: ProblemItem[], severity: ProblemItem["severity"]) => items.filter(item => item.severity === severity).length;
const plural = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

export function runSummary(result: ProblemRun, at: Date): string {
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const errors = count(result.items, "error");
  const warnings = count(result.items, "warning");
  const seconds = Math.round(result.durationMs / 1_000);
  return `Last run ${time}, ${plural(errors, "error")}, ${plural(warnings, "warning")}, ${seconds} s`;
}

export function groupProblems(items: ProblemItem[]): ProblemGroup[] {
  const files = new Map<string, ProblemItem[]>();
  for (const item of items) files.set(item.path, [...(files.get(item.path) ?? []), item]);
  return [...files].map(([path, grouped]) => ({
    path,
    items: grouped,
    errors: count(grouped, "error"),
    warnings: count(grouped, "warning"),
  }));
}

export function Problems({ project, seat, onOpen }: {
  project: string; seat?: string | null; onOpen: (path: string, line: number, column: number) => void;
}) {
  const [checks, setChecks] = useState<ProblemCheck[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProblemRun | null>(null);
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    setChecks([]);
    setSelected("");
    setLoading(true);
    setRunning(false);
    setResult(null);
    setFinishedAt(null);
    setError(null);
    void invoke<string>("problems_checks", { project, seat: seat ?? null }).then(raw => {
      if (!active) return;
      // SAFETY: problems_checks serialises exactly ProblemCheck[] from problems.rs.
      const found = JSON.parse(raw) as ProblemCheck[];
      setChecks(found);
      setSelected(found[0]?.id ?? "");
      setLoading(false);
    }).catch(reason => {
      if (!active) return;
      setError(String(reason));
      setLoading(false);
    });
    return () => {
      active = false;
      if (generation.current === current) generation.current += 1;
    };
  }, [project, seat]);

  const run = async () => {
    if (!selected || running) return;
    const current = ++generation.current;
    setRunning(true);
    setResult(null);
    setFinishedAt(null);
    setError(null);
    try {
      const raw = await invoke<string>("problems_run", { project, seat: seat ?? null, id: selected });
      if (generation.current !== current) return;
      // SAFETY: problems_run serialises exactly ProblemRun from problems.rs.
      setResult(JSON.parse(raw) as ProblemRun);
      setFinishedAt(new Date());
    } catch (reason) {
      if (generation.current === current) setError(String(reason));
    } finally {
      if (generation.current === current) setRunning(false);
    }
  };

  const choose = (id: string) => {
    generation.current += 1;
    setSelected(id);
    setRunning(false);
    setResult(null);
    setFinishedAt(null);
    setError(null);
  };

  const groups = groupProblems(result?.items ?? []);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="problems-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-1.5">
        {checks.length > 0 && (
          <>
            <select aria-label="Problem check" value={selected} disabled={running} onChange={event => choose(event.target.value)}
              className="h-7 min-w-0 max-w-[320px] flex-1 rounded-md border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2 text-v2-body text-[var(--v2-text)] outline-none">
              {checks.map(check => <option key={check.id} value={check.id}>{check.label}</option>)}
            </select>
            <button type="button" aria-label="Run problem check" disabled={running || !selected} onClick={() => { void run(); }}
              className="v2-hover inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--v2-edge)] px-2.5 text-v2-body text-[var(--v2-text)] disabled:opacity-50">
              <Play size={12} aria-hidden /> Run
            </button>
          </>
        )}
        <div role="status" className="shrink-0 text-v2-small text-[var(--v2-muted)]">
          {running ? "Checking" : result && finishedAt ? runSummary(result, finishedAt) : ""}
        </div>
      </div>
      {error && <div role="alert" className="shrink-0 px-3 py-2 text-v2-body text-[var(--v2-bad)]">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {loading && <p className="px-3 py-2 text-v2-body text-[var(--v2-muted)]">Looking for type checks.</p>}
        {!loading && checks.length === 0 && !error && (
          <p className="px-3 py-2 text-v2-body text-[var(--v2-muted)]">No type check found in this project.</p>
        )}
        {!loading && checks.length > 0 && !result && !running && !error && (
          <p className="px-3 py-2 text-v2-body text-[var(--v2-muted)]">Choose a check and press Run.</p>
        )}
        {groups.map(group => (
          <section key={group.path} className="border-b border-[var(--v2-edge)] py-1 last:border-b-0">
            <h3 className="flex items-baseline gap-2 px-3 py-1 text-v2-body font-medium text-[var(--v2-text)]">
              <span className="v2-mono min-w-0 flex-1 truncate" title={group.path}>{group.path}</span>
              <span className="shrink-0 font-normal text-[var(--v2-muted)]">
                {[plural(group.errors, "error"), plural(group.warnings, "warning")].join(", ")}
              </span>
            </h3>
            {group.items.map((item, index) => (
              <button key={`${item.line}:${item.column}:${item.code}:${index}`} type="button"
                aria-label={`Open ${item.path} at ${item.line}:${item.column}`}
                onClick={() => onOpen(item.path, item.line, item.column)}
                className="v2-hover flex w-full items-baseline gap-2 px-3 py-1 text-left text-v2-body">
                <span className={`shrink-0 ${item.severity === "error" ? "text-[var(--v2-bad)]" : "text-[var(--v2-warn)]"}`}>
                  {item.severity}
                </span>
                <span className="v2-mono shrink-0 text-[var(--v2-muted)]">{item.line}:{item.column}</span>
                <span className="min-w-0 flex-1 text-[var(--v2-text-2)]">
                  {item.code && <span className="v2-mono mr-1.5 text-[var(--v2-muted)]">{item.code}</span>}
                  {item.message}
                </span>
              </button>
            ))}
          </section>
        ))}
        {result?.exitCode === 0 && result.items.length === 0 && (
          <p className="px-3 py-2 text-v2-body text-[var(--v2-muted)]">No problems found.</p>
        )}
        {result && result.raw.length > 0 && (
          <pre aria-label="Raw check output" className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-v2-small leading-relaxed text-[var(--v2-bad)]">
            {result.raw.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
