// The pure half of the graph view (#7954, blueprint §4.1): the checkout's file graph collapsed to
// one card per top-level directory, expanded in place per cluster, and recoloured per lens. Every
// lens is a tone over the same cards, never a second drawing.
import type { CodeGraph, GraphEdge, GraphNode } from "./graphApi";
import type { UnreadState } from "./unread";

export type GraphLens = "clusters" | "activity" | "cycles" | "unread";

export const LENSES: readonly GraphLens[] = ["clusters", "activity", "cycles", "unread"];

/** One dirty path in one tree; seat null is the project checkout itself. */
export type DirtyMark = { path: string; seat: string | null };

/** calm = the default; warn = on a cycle under the Cycles lens; dim = outside the lens's
 *  question; selected = the clicked card; linked = a direct dependency or dependent of it;
 *  unread / read = the Unread lens (#7977): changed by the crew and not / since looked at. */
export type Tone = "calm" | "warn" | "dim" | "selected" | "linked" | "unread" | "read";

export type RenderNode = {
  id: string;
  kind: "cluster" | "file";
  label: string;
  cluster: string;
  /** member count for a cluster card, 1 for a file */
  files: number;
  /** who has uncommitted work here, null = the checkout; a cluster carries its members' union */
  seats: (string | null)[];
  cycle: boolean;
  cycleId: number | null;
  inDegree: number;
  outDegree: number;
  /** the Unread lens's state; a cluster is unread while any member is, read while any member is */
  unread: UnreadState;
  tone: Tone;
};

export type RenderEdge = {
  id: string;
  source: string;
  target: string;
  relation: "imports" | "calls";
  /** both ends sit on the same import cycle */
  cycle: boolean;
  tone: Tone;
};

export type DerivedGraph = { nodes: RenderNode[]; edges: RenderEdge[]; clusters: string[] };

export type GraphView = {
  expanded: ReadonlySet<string>;
  lens: GraphLens;
  dirty: readonly DirtyMark[];
  selected: string | null;
  /** per path, from unreadMarks(); absent = nothing is unread */
  unread?: ReadonlyMap<string, UnreadState>;
};

export const CLUSTER_PREFIX = "@dir:";
export const ROOT_CLUSTER = "(root)";

export const clusterName = (node: GraphNode): string => node.cluster || ROOT_CLUSTER;
export const clusterId = (cluster: string): string => CLUSTER_PREFIX + cluster;
export const clusterOfId = (id: string): string | null =>
  id.startsWith(CLUSTER_PREFIX) ? id.slice(CLUSTER_PREFIX.length) : null;

const baseName = (path: string): string => path.split("/").pop() ?? path;

function addSeat(seats: (string | null)[], seat: string | null) {
  if (!seats.includes(seat)) seats.push(seat);
}

function clusterUnread(list: readonly GraphNode[], marks: ReadonlyMap<string, UnreadState> | undefined): UnreadState {
  if (!marks) return "unchanged";
  let state: UnreadState = "unchanged";
  for (const node of list) {
    const s = marks.get(node.id);
    if (s === "unread") return "unread";
    if (s === "read") state = "read";
  }
  return state;
}

function edgeCycle(source: GraphNode, target: GraphNode): boolean {
  return source.cycleId !== null && source.cycleId === target.cycleId;
}

type Pending = { source: string; target: string; imports: boolean; cycle: boolean };

export function deriveGraph(graph: CodeGraph, view: GraphView): DerivedGraph {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const dirtyByPath = new Map<string, (string | null)[]>();
  for (const mark of view.dirty) {
    const seats = dirtyByPath.get(mark.path);
    if (seats) addSeat(seats, mark.seat);
    else dirtyByPath.set(mark.path, [mark.seat]);
  }

  const members = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    const name = clusterName(node);
    const list = members.get(name);
    if (list) list.push(node);
    else members.set(name, [node]);
  }
  const clusters = [...members.keys()].sort();
  const representing = (node: GraphNode): string =>
    view.expanded.has(clusterName(node)) ? node.id : clusterId(clusterName(node));

  const nodes: RenderNode[] = [];
  for (const cluster of clusters) {
    const list = (members.get(cluster) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    if (view.expanded.has(cluster)) {
      for (const node of list) {
        nodes.push({
          id: node.id,
          kind: "file",
          label: baseName(node.id),
          cluster,
          files: 1,
          seats: dirtyByPath.get(node.id) ?? [],
          cycle: node.cycleId !== null,
          cycleId: node.cycleId,
          inDegree: node.inDegree,
          outDegree: node.outDegree,
          unread: view.unread?.get(node.id) ?? "unchanged",
          tone: "calm",
        });
      }
      continue;
    }
    const seats: (string | null)[] = [];
    for (const node of list) for (const seat of dirtyByPath.get(node.id) ?? []) addSeat(seats, seat);
    nodes.push({
      id: clusterId(cluster),
      kind: "cluster",
      label: cluster,
      cluster,
      files: list.length,
      seats,
      cycle: list.some(node => node.cycleId !== null),
      cycleId: null,
      inDegree: 0,
      outDegree: 0,
      unread: clusterUnread(list, view.unread),
      tone: "calm",
    });
  }

  const pending = new Map<string, Pending>();
  const degrees = new Map<string, { inDegree: number; outDegree: number }>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const s = representing(source);
    const t = representing(target);
    if (s === t) continue;
    const key = `${s}\n${t}`;
    const cycle = edgeCycle(source, target);
    const seen = pending.get(key);
    if (seen) {
      seen.imports = seen.imports || edge.relation === "imports";
      seen.cycle = seen.cycle || cycle;
    } else {
      pending.set(key, { source: s, target: t, imports: edge.relation === "imports", cycle });
      const out = degrees.get(s) ?? { inDegree: 0, outDegree: 0 };
      out.outDegree += 1;
      degrees.set(s, out);
      const into = degrees.get(t) ?? { inDegree: 0, outDegree: 0 };
      into.inDegree += 1;
      degrees.set(t, into);
    }
  }
  for (const node of nodes) {
    if (node.kind !== "cluster") continue;
    const d = degrees.get(node.id);
    if (d) {
      node.inDegree = d.inDegree;
      node.outDegree = d.outDegree;
    }
  }
  const edges: RenderEdge[] = [...pending.values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
    .map(p => ({
      id: `${p.source}\n${p.target}`,
      source: p.source,
      target: p.target,
      relation: p.imports ? "imports" : "calls",
      cycle: p.cycle,
      tone: "calm",
    }));

  tone(nodes, edges, view);
  return { nodes, edges, clusters };
}

function tone(nodes: RenderNode[], edges: RenderEdge[], view: GraphView) {
  const dirty = new Set(nodes.filter(n => n.seats.length > 0).map(n => n.id));
  const linked = new Set<string>();
  if (view.selected) {
    for (const e of edges) {
      if (e.source === view.selected) linked.add(e.target);
      if (e.target === view.selected) linked.add(e.source);
    }
  }
  for (const n of nodes) {
    if (n.id === view.selected) n.tone = "selected";
    else if (linked.has(n.id)) n.tone = "linked";
    else if (view.lens === "cycles") n.tone = n.cycle ? "warn" : "dim";
    else if (view.lens === "activity") n.tone = dirty.has(n.id) ? "calm" : "dim";
    else if (view.lens === "unread") n.tone = n.unread === "unchanged" ? "calm" : n.unread;
    else n.tone = "calm";
  }
  for (const e of edges) {
    const touchesSelected = e.source === view.selected || e.target === view.selected;
    if (touchesSelected) e.tone = "linked";
    else if (view.lens === "cycles") e.tone = e.cycle ? "warn" : "dim";
    else if (view.lens === "activity") e.tone = dirty.has(e.source) || dirty.has(e.target) ? "calm" : "dim";
    else e.tone = "calm";
  }
}

/** A cluster's expand/collapse toggle, as a new set so React sees the change. */
export function toggleCluster(expanded: ReadonlySet<string>, cluster: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(cluster)) next.delete(cluster);
  else next.add(cluster);
  return next;
}

/** The dirty marks GraphView overlays: one per (seat, path) row from `project_changes`. */
export function dirtyMarks(rows: readonly { seat: string | null; path: string }[]): DirtyMark[] {
  return rows.map(r => ({ path: r.path, seat: r.seat }));
}

/** Import edges only cross clusters when the cluster cards are collapsed; this is the count the
 *  header shows so the operator knows how much the picture is hiding. */
export function hiddenEdges(graph: CodeGraph, derived: DerivedGraph): number {
  return graph.edges.length - derived.edges.length;
}

export type { GraphEdge };
