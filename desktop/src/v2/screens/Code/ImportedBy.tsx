// #14268: the file tab's plain-words replacement for the classic "skim · 0 dependents" chip. Hidden when the graph has no answer.
import { useEffect, useState } from "react";
import { graphApi, isGraphError, type GraphApi } from "../../../features/code/graph/graphApi";
import { scopeGraph } from "../../../features/code/ReviewChip";
import { Button } from "../../ui/Button";

/** The files with an import edge straight into `path`, or null when the graph has no node for it. */
export function importersOf(graph: { nodes: { id: string }[]; edges: { source: string; target: string }[] }, path: string): string[] | null {
  if (!graph.nodes.some(n => n.id === path)) return null;
  return [...new Set(graph.edges.filter(e => e.target === path && e.source !== path).map(e => e.source))].sort();
}

export function importedByText(count: number): string {
  return count === 0 ? "No other files import this" : `Imported by ${count} ${count === 1 ? "file" : "files"}`;
}

export function ImportedBy({ project, scope, path, onOpenFile, api = graphApi }: {
  project: string; scope: string | null; path: string; onOpenFile?: (path: string) => void; api?: GraphApi;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setFiles(null);
    setOpen(false);
    scopeGraph(api, project, scope)
      .then(r => { if (alive) setFiles(isGraphError(r) ? null : importersOf(r, path)); })
      .catch(() => { if (alive) setFiles(null); });
    return () => { alive = false; };
  }, [api, project, scope, path]);
  if (!files) return null;
  const text = importedByText(files.length);
  if (files.length === 0) return <span data-testid="imported-by" className="shrink-0 text-v2-small text-[var(--v2-muted)]">{text}</span>;
  return (
    <span className="relative shrink-0">
      <Button variant="quiet" data-testid="imported-by" aria-expanded={open} className="!px-2 !py-0.5 !text-v2-small" onClick={() => setOpen(o => !o)}>{text}</Button>
      {open && (
        <div role="list" aria-label="Files that import this" className="absolute right-0 top-full z-20 mt-1 max-h-[240px] w-[320px] overflow-auto rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] py-1">
          {files.map(f => (
            <button key={f} type="button" role="listitem" title={f} onClick={() => { setOpen(false); onOpenFile?.(f); }}
              className="v2-hover v2-mono block w-full truncate border-0 bg-transparent px-3 py-1 text-left text-v2-small text-[var(--v2-text)]">{f}</button>
          ))}
        </div>
      )}
    </span>
  );
}
