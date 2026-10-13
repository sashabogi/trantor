// The graph's view state, lifted out of GraphView (#11603): opening a file from the graph unmounts
// it, and coming back must find the graph as it was left. Module-level and keyed by project (the
// documents-store convention, #5938), so project A's layout, lens, expanded districts, selection
// and pan never show up in project B. Memory only: a restart opens a fresh graph.
import type { GraphLens } from "./deriveGraph";

/** flow = Flare's flow layout (the default); districts = the treemap (#7978). */
export type GraphLayout = "flow" | "districts";

export type GraphViewState = {
  expanded: ReadonlySet<string>;
  lens: GraphLens;
  agentFilter: string | null;
  layout: GraphLayout;
  selected: string | null;
  /** The canvas scroll offsets: the graph's pan. */
  scrollLeft: number;
  scrollTop: number;
};

const fresh = (): GraphViewState => ({
  expanded: new Set(),
  lens: "clusters",
  agentFilter: null,
  layout: "flow",
  selected: null,
  scrollLeft: 0,
  scrollTop: 0,
});

const states = new Map<string, GraphViewState>();

export function graphViewState(project: string): GraphViewState {
  return states.get(project) ?? fresh();
}

export function saveGraphViewState(project: string, patch: Partial<GraphViewState>): void {
  states.set(project, { ...graphViewState(project), ...patch });
}

/** Test seam: forget every project's graph. */
export function resetGraphViewStates(): void {
  states.clear();
}
