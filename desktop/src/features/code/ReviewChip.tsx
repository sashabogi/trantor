// The review chip on the Changes strip (#7971, blueprint §4.2): the open file's tier and its
// transitive dependents off the scope's code_graph, tr-warn at careful, "not in the graph" for a
// path graft has no node for (never a silent zero). A click opens the scope's graph tab.
import { useEffect, useState } from "react";
import { graphApi, isGraphError, type CodeGraphResponse, type GraphApi } from "./graph/graphApi";
import { chipText, fileReview, type FileReview } from "./reviewTier";

/** One graph per scope, kept this long: the chip must not run `graft build` on every tab switch. */
export const GRAPH_TTL_MS = 30_000;
const scopeGraphs = new Map<string, { at: number; graph: Promise<CodeGraphResponse> }>();

export function scopeGraph(api: GraphApi, project: string, seat: string | null, now = Date.now()): Promise<CodeGraphResponse> {
  const key = `${project}:${seat ?? ""}`;
  const hit = scopeGraphs.get(key);
  if (hit && now - hit.at < GRAPH_TTL_MS) return hit.graph;
  const graph = api.graph(project, seat ?? undefined);
  scopeGraphs.set(key, { at: now, graph });
  graph.catch(() => scopeGraphs.delete(key));
  return graph;
}

type ChipState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; review: FileReview };

export function ReviewChip({ project, seat, path, onOpenGraph, api = graphApi }: {
  project: string;
  seat: string | null;
  path: string;
  onOpenGraph: () => void;
  /** Injected by the drill; the app uses the real command. */
  api?: GraphApi;
}) {
  const [state, setState] = useState<ChipState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    scopeGraph(api, project, seat)
      .then(r => {
        if (!alive) return;
        setState(isGraphError(r) ? { kind: "error", message: r.error } : { kind: "review", review: fileReview(r, path) });
      })
      .catch(e => { if (alive) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [api, project, seat, path]);

  if (state.kind === "loading") return <span className="tr-chip" data-testid="review-chip" data-tier="loading">reading the graph…</span>;
  if (state.kind === "error") return <span className="tr-chip" data-testid="review-chip" data-tier="unavailable" title={state.message}>graph unavailable</span>;
  const { review } = state;
  const tier = "notInGraph" in review ? "none" : review.tier;
  const title = "notInGraph" in review
    ? "graft has no node for this path, so its dependents are unknown rather than zero"
    : `${review.reasons.join("; ")} · open the graph`;
  return (
    <button
      type="button"
      data-testid="review-chip"
      data-tier={tier}
      title={title}
      onClick={onOpenGraph}
      className={`tr-chip ${tier === "careful" ? "text-[var(--color-tr-warn)]" : ""}`}
    >
      {chipText(review)}
    </button>
  );
}
