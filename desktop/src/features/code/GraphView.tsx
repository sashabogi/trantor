// The graph view on the Code surface (#7954, blueprint §4.1): the scope's file graph from
// `code_graph`, drawn as Flare's flow layout, opened collapsed to one card per top-level
// directory (rule 7), each cluster expanding in place. Clusters / Activity / Cycles are tones
// over the same cards. No drag, no persisted positions: the layout is deterministic.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hueOf } from "../../shared/Avatar";
import { hierarchicalFlowLayout, type Point } from "./graph/flowLayout";
import {
  clusterOfId,
  deriveGraph,
  dirtyMarks,
  LENSES,
  toggleCluster,
  type DirtyMark,
  type GraphLens,
  type RenderEdge,
  type RenderNode,
  type Tone,
} from "./graph/deriveGraph";
import { GRAFT_MISSING, graphApi, isGraphError, type CodeGraphResponse, type GraphApi } from "./graph/graphApi";
import { isBuildOutput, quietRebuild, rebuildWorthy } from "./graph/refresh";
import { unreadCount, unreadMarks, type ChangeStamp, type FileEvent } from "./graph/unread";

const CARD_W = 112;
const CARD_H = 30;
const PAD = 40;

/** Cluster hue at low saturation, on the card's leading edge only: colour in content, not chrome. */
const clusterTint = (cluster: string) => `hsl(${hueOf(cluster)} 28% 58% / 0.55)`;
const seatTint = (seat: string | null) => (seat ? `hsl(${hueOf(seat)} 55% 62%)` : "var(--color-tr-muted)");

const NODE_BORDER = {
  calm: undefined,
  warn: "var(--color-tr-warn)",
  dim: undefined,
  selected: "var(--color-tr-doing)",
  linked: "var(--color-tr-doing)",
  unread: "var(--color-tr-fail)",
  read: "var(--color-tr-ok)",
} satisfies { [T in Tone]: string | undefined };

/** The Unread lens's fills (#7977): unread in tr-fail at low alpha, changed-and-read in tr-ok. */
const NODE_FILL = {
  calm: undefined,
  warn: undefined,
  dim: undefined,
  selected: undefined,
  linked: undefined,
  unread: "color-mix(in srgb, var(--color-tr-fail) 16%, transparent)",
  read: "color-mix(in srgb, var(--color-tr-ok) 12%, transparent)",
} satisfies { [T in Tone]: string | undefined };

const LEGEND = [
  { label: "changed, not read", color: "var(--color-tr-fail)" },
  { label: "changed and read", color: "var(--color-tr-ok)" },
  { label: "unchanged this session", color: "var(--color-tr-edge)" },
];

const EDGE_STROKE = {
  calm: "var(--color-tr-edge)",
  warn: "var(--color-tr-warn)",
  dim: "var(--color-tr-edge)",
  selected: "var(--color-tr-doing)",
  linked: "var(--color-tr-doing)",
  unread: "var(--color-tr-edge)",
  read: "var(--color-tr-edge)",
} satisfies { [T in Tone]: string };

type Placed = { node: RenderNode; left: number; top: number };

/** One stamp per path, the newest batch winning. */
function stampsWith(prev: readonly ChangeStamp[], paths: readonly string[], ts: number): ChangeStamp[] {
  const changed = new Set(paths.filter(p => p.length > 0 && !isBuildOutput(p)));
  if (changed.size === 0) return prev.slice();
  const next = prev.filter(s => !changed.has(s.path));
  for (const path of changed) next.push({ path, ts });
  return next;
}

function place(nodes: RenderNode[], edges: RenderEdge[]) {
  const layout = hierarchicalFlowLayout(
    nodes.map(n => ({ id: n.id, cluster: n.kind === "cluster" ? n.label : n.cluster })),
    edges.map(e => ({ source: e.source, target: e.target })),
    1.6,
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of layout.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { placed: [], centers: new Map<string, Point>(), width: 0, height: 0 };
  const dx = PAD + CARD_W / 2 - minX;
  const dy = PAD + CARD_H / 2 - minY;
  const centers = new Map<string, Point>();
  const placed: Placed[] = [];
  for (const node of nodes) {
    const p = layout.get(node.id);
    if (!p) continue;
    const center = { x: p.x + dx, y: p.y + dy };
    centers.set(node.id, center);
    placed.push({ node, left: center.x - CARD_W / 2, top: center.y - CARD_H / 2 });
  }
  return { placed, centers, width: maxX + dx + CARD_W / 2 + PAD, height: maxY + dy + CARD_H / 2 + PAD };
}

/** Importer on the right, imported on the left: the curve leaves the source's left edge and
 *  lands on the target's right edge, bending horizontally. */
function edgePath(from: Point, to: Point): string {
  const sx = from.x - CARD_W / 2;
  const tx = to.x + CARD_W / 2;
  const bend = Math.max(24, Math.abs(sx - tx) / 3);
  return `M ${sx} ${from.y} C ${sx - bend} ${from.y}, ${tx + bend} ${to.y}, ${tx} ${to.y}`;
}

export function GraphView({ project, seat, onOpen, api = graphApi }: {
  project: string;
  seat: string | null;
  /** A file card opens its path in a code tab under the same scope (Files.tsx openPath). */
  onOpen: (path: string) => void;
  /** Injected by the S-graph drill; the app uses the real commands. */
  api?: GraphApi;
}) {
  const [response, setResponse] = useState<CodeGraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<DirtyMark[]>([]);
  const [fileEvents, setFileEvents] = useState<FileEvent[]>([]);
  // Opening a card from the graph is the read: the lens clears at once, the hub's event follows.
  const [localReads, setLocalReads] = useState<FileEvent[]>([]);
  const [stamps, setStamps] = useState<ChangeStamp[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [lens, setLens] = useState<GraphLens>("clusters");
  const [selected, setSelected] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  // Only the newest request may land: a slow build must not overwrite a newer scope's graph.
  const requestRef = useRef(0);

  const load = useCallback((mode: "fresh" | "rebuild") => {
    const id = ++requestRef.current;
    if (mode === "fresh") {
      setResponse(null);
      setLoadError(null);
      setRebuilding(false);
    } else {
      setRebuilding(true);
    }
    return api.graph(project, seat ?? undefined)
      .then(r => { if (id === requestRef.current) { setResponse(r); setLoadError(null); } })
      .catch(e => { if (id === requestRef.current) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (id === requestRef.current) setRebuilding(false); });
  }, [api, project, seat]);

  useEffect(() => {
    void load("fresh");
    return () => { requestRef.current++; };
  }, [load]);

  // Refresh (#7953): one rebuild per quiet second, the old canvas up while graft runs. The
  // watcher sees the main checkout only, so a seat scope rebuilds from its refresh chip.
  useEffect(() => {
    if (seat !== null) return;
    const scheduler = quietRebuild(() => load("rebuild"));
    const off = api.fileChanges(project, paths => {
      if (!rebuildWorthy(paths)) return;
      scheduler.touch();
      const ts = Date.now();
      setStamps(prev => stampsWith(prev, paths, ts));
    });
    return () => { scheduler.cancel(); off(); setStamps([]); };
  }, [api, project, seat, load]);

  // The same project-wide change rows the ModePane polls: which nodes are dirty, in whose tree.
  useEffect(() => {
    let alive = true;
    const pull = () => {
      api.changes(project)
        .then(rows => { if (alive) setDirty(dirtyMarks(rows)); })
        .catch(() => { if (alive) setDirty([]); });
      (api.fileEvents ? api.fileEvents(project) : Promise.resolve([]))
        .then(events => { if (alive) setFileEvents(events); })
        .catch(() => { if (alive) setFileEvents([]); });
    };
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); setLocalReads([]); };
  }, [api, project]);

  const unread = useMemo(
    () => unreadMarks([...fileEvents, ...localReads], stamps),
    [fileEvents, localReads, stamps],
  );

  const graph = response && !isGraphError(response) ? response : null;
  const derived = useMemo(
    () => (graph ? deriveGraph(graph, { expanded, lens, dirty, selected, unread }) : null),
    [graph, expanded, lens, dirty, selected, unread],
  );
  const scene = useMemo(() => (derived ? place(derived.nodes, derived.edges) : null), [derived]);

  const onCard = (node: RenderNode) => {
    const cluster = clusterOfId(node.id);
    if (cluster !== null) {
      setExpanded(current => toggleCluster(current, cluster));
      setSelected(null);
      return;
    }
    setSelected(node.id);
    setLocalReads(prev => [...prev, { type: "file.read", ts: Date.now(), file: node.id }]);
    onOpen(node.id);
  };

  const error = loadError ?? (response && isGraphError(response) ? response.error : null);
  const scopeLabel = seat ? `seat/${seat}` : "the project checkout";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graph-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-1.5 pb-1.5 pt-0.5">
        <div className="tr-seg" data-testid="graph-lens" role="tablist" aria-label="Graph lens">
          {LENSES.map(l => (
            <button key={l} type="button" role="tab" data-on={lens === l} aria-selected={lens === l} onClick={() => setLens(l)}>
              {l}
            </button>
          ))}
        </div>
        {graph && derived && (
          <span className="tr-mono text-[11px] text-tr-muted" data-testid="graph-meta">
            {graph.meta.files} files · {graph.meta.edges} edges · {derived.clusters.length} clusters
            {graph.meta.cycles > 0 ? ` · ${graph.meta.cycles} cycles` : ""}
            {graph.meta.externalTargets > 0 ? ` · ${graph.meta.externalTargets} external` : ""}
          </span>
        )}
        {rebuilding && (
          <span className="tr-mono text-[11px] text-tr-muted" data-testid="graph-rebuilding">rebuilding…</span>
        )}
        {lens === "unread" && (
          <>
            <span className="tr-mono text-[11px] text-tr-muted" data-testid="graph-unread-count">
              {unreadCount(unread)} unread
            </span>
            <span className="flex items-center gap-2.5 text-[11px] text-tr-muted" data-testid="graph-legend">
              {LEGEND.map(l => (
                <span key={l.label} className="flex items-center gap-1">
                  <span className="tr-dot" style={{ background: l.color, width: 7, height: 7 }} />
                  {l.label}
                </span>
              ))}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {expanded.size > 0 && (
            <button
              type="button"
              onClick={() => { setExpanded(new Set()); setSelected(null); }}
              className="tr-chip hover:text-tr-text"
            >
              collapse all
            </button>
          )}
          <button
            type="button"
            onClick={() => { void load("rebuild"); }}
            title="Rebuild the graph from this scope's tree"
            className="tr-chip hover:text-tr-text"
          >
            refresh
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto" data-testid="graph-canvas">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed" data-testid="graph-error">
              {error === GRAFT_MISSING
                ? <>graft is not installed, so there is no graph to draw. Install it with <code className="tr-mono">npm i -g @nanonets/graft</code> and press refresh.</>
                : error}
            </div>
          </div>
        ) : !scene || !derived ? (
          <div className="flex h-full items-center justify-center">
            <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
              building the graph of {scopeLabel}…
            </div>
          </div>
        ) : scene.placed.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
              graft found no code files in {scopeLabel}.
            </div>
          </div>
        ) : (
          <div className="relative" style={{ width: scene.width, height: scene.height }}>
            <svg className="pointer-events-none absolute inset-0" width={scene.width} height={scene.height} aria-hidden="true">
              {derived.edges.map(e => {
                const from = scene.centers.get(e.source);
                const to = scene.centers.get(e.target);
                if (!from || !to) return null;
                return (
                  <path
                    key={e.id}
                    d={edgePath(from, to)}
                    fill="none"
                    stroke={EDGE_STROKE[e.tone]}
                    strokeWidth={e.tone === "linked" || e.tone === "warn" ? 1.5 : 1}
                    strokeDasharray={e.relation === "calls" ? "3 3" : undefined}
                    opacity={e.tone === "dim" ? 0.25 : 0.9}
                    data-graph-edge={e.id}
                    data-graph-tone={e.tone}
                  />
                );
              })}
            </svg>
            {scene.placed.map(({ node, left, top }) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onCard(node)}
                data-graph-node={node.id}
                data-graph-kind={node.kind}
                data-graph-cluster={node.cluster}
                data-graph-tone={node.tone}
                title={node.kind === "cluster"
                  ? `${node.label} · ${node.files} files · click to expand`
                  : `${node.id} · ${node.inDegree} in · ${node.outDegree} out`}
                className="tr-card absolute flex items-center gap-1.5 px-2 text-left text-[11.5px] text-tr-text"
                style={{
                  left,
                  top,
                  width: CARD_W,
                  height: CARD_H,
                  borderRadius: 8,
                  borderLeftWidth: 3,
                  borderLeftColor: clusterTint(node.cluster),
                  borderColor: NODE_BORDER[node.tone],
                  background: NODE_FILL[node.tone],
                  opacity: node.tone === "dim" ? 0.35 : 1,
                  fontWeight: node.kind === "cluster" ? 600 : 400,
                }}
              >
                <span className="min-w-0 flex-1 truncate">{node.label}</span>
                {node.kind === "cluster" && (
                  <span className="tr-mono shrink-0 text-[10px] text-tr-muted">{node.files}</span>
                )}
                {node.seats.map(s => (
                  <span
                    key={s ?? "checkout"}
                    className="tr-dot shrink-0"
                    style={{ background: seatTint(s), width: 6, height: 6 }}
                    title={s ? `${s} has uncommitted work here` : "uncommitted work in the checkout"}
                    data-graph-seat={s ?? "checkout"}
                  />
                ))}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
