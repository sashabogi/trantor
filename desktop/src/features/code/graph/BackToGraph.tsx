// The way back from a file opened off the graph (#11603): a small chip in the Code view's header.
// It shows only while the open file IS the one the graph opened, so a file picked from the tree
// never carries it.
import type { GraphOrigin } from "./graphOrigin";

export function BackToGraph({ origin, project, activePath, onBack }: {
  origin: GraphOrigin | null;
  project: string;
  activePath: string | null;
  onBack: () => void;
}) {
  if (!origin || origin.project !== project || origin.path !== activePath) return null;
  return (
    <button
      type="button"
      onClick={onBack}
      title="Back to the graph, as you left it (Cmd+[)"
      className="tr-chip hover:text-tr-text"
      data-testid="back-to-graph"
    >
      ← back to graph
    </button>
  );
}
