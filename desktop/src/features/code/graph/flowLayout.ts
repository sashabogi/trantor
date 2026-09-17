// Vendored from Flare src/graph/flowLayout.ts plus findCycles from shared/graph.ts (5adc94b),
// MIT License, Copyright (c) 2026 AlgoNoRhythm; the notice is LICENSE.flare beside this file.
// Local edits (#7954): positions are a Map, not a Record (anti-slop dictionary rule);
// findCycles is inlined; comment blocks trimmed to the comment policy (#6450).

export type FlowNode = { id: string; cluster: string };
export type FlowEdge = { source: string; target: string };
export type Point = { x: number; y: number };

export const COL_SPACING = 130;
export const ROW_SPACING = 42;

/** Iterative Tarjan SCC: node -> component id, for components of more than one node only. */
export function findCycles(adjacency: Map<string, string[]>): Map<string, number> {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, number>();
  let componentId = 0;

  for (const start of adjacency.keys()) {
    if (index.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame[0];
      if (frame[1] === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      let recursed = false;
      while (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]];
        frame[1]++;
        if (!index.has(next)) {
          work.push([next, 0]);
          recursed = true;
          break;
        }
        if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node) ?? 0, index.get(next) ?? 0));
        }
      }
      if (recursed) continue;
      if (lowlink.get(node) === index.get(node)) {
        const component: string[] = [];
        let popped: string | undefined;
        do {
          popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== node);
        if (component.length > 1) {
          for (const member of component) result.set(member, componentId);
          componentId++;
        }
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0]) ?? 0, lowlink.get(node) ?? 0));
      }
    }
  }
  return result;
}

// Packs column widths into bands so the block lands near `aspect` (w/h) instead of one strip;
// reading order stays left to right, then down. Small graphs never wrap.
function bandify(widths: number[], heights: number[], aspect: number | undefined): number[][] {
  const all = widths.map((_, i) => i);
  if (!aspect || widths.length < 5) return [all];
  const totalW = widths.reduce((a, b) => a + b, 0);
  const maxH = Math.max(...heights, 1);
  if (totalW / maxH <= aspect) return [all];
  const bandCount = Math.max(2, Math.round(Math.sqrt(totalW / (maxH * aspect))));
  const target = totalW / bandCount;
  const bands: number[][] = [];
  let current: number[] = [];
  let width = 0;
  for (let i = 0; i < widths.length; i++) {
    if (current.length > 0 && width + widths[i] / 2 > target) {
      bands.push(current);
      current = [];
      width = 0;
    }
    current.push(i);
    width += widths[i];
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

/** Left-to-right dependency layout: foundations left, entry points right. Layers are longest-path
 *  depth over the SCC-condensed graph; barycenter sweeps order each column. Deterministic. */
export function flowLayout(nodes: FlowNode[], edges: FlowEdge[], wrapAspect?: number): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;
  const ids = new Set(nodes.map(n => n.id));
  const validEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);

  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of validEdges) adjacency.get(e.source)?.push(e.target);
  const cycleIds = findCycles(adjacency);
  const unitOf = (id: string): string => {
    const cycle = cycleIds.get(id);
    return cycle === undefined ? id : `#scc${cycle}`;
  };

  const unitMembers = new Map<string, string[]>();
  for (const n of nodes) {
    const u = unitOf(n.id);
    const members = unitMembers.get(u);
    if (members) members.push(n.id);
    else unitMembers.set(u, [n.id]);
  }
  const unitEdges = new Map<string, Set<string>>();
  for (const u of unitMembers.keys()) unitEdges.set(u, new Set());
  for (const e of validEdges) {
    const us = unitOf(e.source);
    const ut = unitOf(e.target);
    if (us !== ut) unitEdges.get(us)?.add(ut);
  }

  // longest-path depth: depth(u) = 1 + max(depth of imports), iterative
  const depth = new Map<string, number>();
  const stack = [...unitMembers.keys()];
  while (stack.length > 0) {
    const u = stack[stack.length - 1];
    if (depth.has(u)) {
      stack.pop();
      continue;
    }
    let ready = true;
    let d = 0;
    for (const dep of unitEdges.get(u) ?? []) {
      const dd = depth.get(dep);
      if (dd === undefined) {
        stack.push(dep);
        ready = false;
      } else {
        d = Math.max(d, dd + 1);
      }
    }
    if (ready) {
      depth.set(u, d);
      stack.pop();
    }
  }

  const clusterOf = new Map(nodes.map(n => [n.id, n.cluster]));
  const columns = new Map<number, string[]>();
  for (const u of unitMembers.keys()) {
    const d = depth.get(u) ?? 0;
    const column = columns.get(d);
    if (column) column.push(u);
    else columns.set(d, [u]);
  }
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  const column = (d: number): string[] => columns.get(d) ?? [];

  const unitCluster = (u: string) => clusterOf.get(unitMembers.get(u)?.[0] ?? "") ?? "";
  for (const d of sortedDepths) {
    column(d).sort((a, b) => unitCluster(a).localeCompare(unitCluster(b)) || a.localeCompare(b));
  }

  const orderIndex = new Map<string, number>();
  for (const d of sortedDepths) column(d).forEach((u, i) => orderIndex.set(u, i));
  const inbound = new Map<string, string[]>();
  for (const [us, targets] of unitEdges) {
    for (const ut of targets) {
      const importers = inbound.get(ut);
      if (importers) importers.push(us);
      else inbound.set(ut, [us]);
    }
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    for (const d of forward ? sortedDepths : [...sortedDepths].reverse()) {
      const col = column(d);
      const bary = (u: string): number => {
        const refs = forward ? [...(unitEdges.get(u) ?? [])] : (inbound.get(u) ?? []);
        const positionsOfRefs = refs
          .map(r => orderIndex.get(r))
          .filter((v): v is number => v !== undefined);
        if (positionsOfRefs.length === 0) return orderIndex.get(u) ?? 0;
        return positionsOfRefs.reduce((a, b) => a + b, 0) / positionsOfRefs.length;
      };
      col.sort((a, b) => {
        const diff = bary(a) - bary(b);
        if (Math.abs(diff) > 1e-9) return diff;
        return unitCluster(a).localeCompare(unitCluster(b)) || a.localeCompare(b);
      });
      col.forEach((u, i) => orderIndex.set(u, i));
    }
  }

  const rowCounts = sortedDepths.map(d => {
    let total = 0;
    for (const u of column(d)) total += unitMembers.get(u)?.length ?? 0;
    return total;
  });
  const bands = bandify(
    sortedDepths.map(() => COL_SPACING),
    rowCounts.map(r => r * ROW_SPACING),
    wrapAspect,
  );

  const BAND_GAP = ROW_SPACING * 2.4;
  let yBase = 0;
  for (const band of bands) {
    const bandRows = Math.max(...band.map(i => rowCounts[i]));
    for (const i of band) {
      const col = column(sortedDepths[i]);
      const x = (i - band[0]) * COL_SPACING;
      let row = -(rowCounts[i] - 1) / 2;
      for (const u of col) {
        for (const id of [...(unitMembers.get(u) ?? [])].sort()) {
          positions.set(id, { x, y: yBase + row * ROW_SPACING });
          row += 1;
        }
      }
    }
    yBase += (bandRows - 1) * ROW_SPACING + BAND_GAP;
  }
  return positions;
}

type LocalBlock = { pos: Map<string, Point>; w: number; h: number };

/** Two-level layout: clusters become blocks ordered left to right by inter-cluster depth, stacked
 *  within a depth; each cluster's members get a compact flow inside their block. Deterministic. */
export function hierarchicalFlowLayout(nodes: FlowNode[], edges: FlowEdge[], wrapAspect?: number): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;
  const clusterOf = new Map(nodes.map(n => [n.id, n.cluster || "(root)"]));
  const clusters = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    const c = clusterOf.get(n.id) ?? "(root)";
    const members = clusters.get(c);
    if (members) members.push(n);
    else clusters.set(c, [n]);
  }

  const clusterEdgeSet = new Map<string, FlowEdge>();
  const internalEdges = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const cs = clusterOf.get(e.source);
    const ct = clusterOf.get(e.target);
    if (!cs || !ct) continue;
    if (cs === ct) {
      const list = internalEdges.get(cs);
      if (list) list.push(e);
      else internalEdges.set(cs, [e]);
    } else {
      clusterEdgeSet.set(`${cs}\n${ct}`, { source: cs, target: ct });
    }
  }
  const clusterLayout = flowLayout(
    [...clusters.keys()].map(c => ({ id: c, cluster: "" })),
    [...clusterEdgeSet.values()],
  );

  // the renderer sizes cards off COL_SPACING/ROW_SPACING, so the local grid is not scaled
  const locals = new Map<string, LocalBlock>();
  for (const [c, members] of clusters) {
    const local = flowLayout(
      members.map(m => ({ id: m.id, cluster: "" })),
      internalEdges.get(c) ?? [],
      wrapAspect,
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of local.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const p of local.values()) {
      p.x -= cx;
      p.y -= cy;
    }
    locals.set(c, { pos: local, w: Math.max(maxX - minX, 40), h: Math.max(maxY - minY, 40) });
  }

  const H_GAP = 150;
  const V_GAP = 95;
  const byDepth = new Map<number, string[]>();
  for (const c of clusters.keys()) {
    const depth = Math.round((clusterLayout.get(c)?.x ?? 0) / COL_SPACING);
    const list = byDepth.get(depth);
    if (list) list.push(c);
    else byDepth.set(depth, [c]);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const blockColumns = depths.map(d =>
    (byDepth.get(d) ?? []).sort((a, b) => (clusterLayout.get(a)?.y ?? 0) - (clusterLayout.get(b)?.y ?? 0)),
  );
  const blockOf = (c: string): LocalBlock => locals.get(c) ?? { pos: new Map(), w: 40, h: 40 };
  const colWidths = blockColumns.map(list => Math.max(...list.map(c => blockOf(c).w)) + H_GAP);
  const colHeights = blockColumns.map(
    list => list.reduce((acc, c) => acc + blockOf(c).h, 0) + V_GAP * (list.length - 1),
  );

  const bands = bandify(colWidths, colHeights, wrapAspect);
  let yBase = 0;
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b];
    const bandHeight = Math.max(...band.map(i => colHeights[i]));
    let xCursor = 0;
    for (const i of band) {
      let yCursor = yBase - colHeights[i] / 2;
      for (const c of blockColumns[i]) {
        const { pos, h } = blockOf(c);
        const centerX = xCursor + (colWidths[i] - H_GAP) / 2;
        const centerY = yCursor + h / 2;
        for (const [id, p] of pos) {
          positions.set(id, { x: centerX + p.x, y: centerY + p.y });
        }
        yCursor += h + V_GAP;
      }
      xCursor += colWidths[i];
    }
    const next = bands[b + 1];
    if (next) {
      yBase += bandHeight / 2 + V_GAP * 1.8 + Math.max(...next.map(i => colHeights[i])) / 2;
    }
  }
  return positions;
}
