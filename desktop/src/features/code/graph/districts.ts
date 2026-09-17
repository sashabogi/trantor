// The districts layout (#7978, blueprint §4.1): a squarified treemap, every file an area
// proportional to its size packed inside its cluster, the picture for "how much of the code is
// in this state". squarify is vendored from Flare src/components/DistrictsView.tsx (5adc94b),
// MIT License, Copyright (c) 2026 AlgoNoRhythm; the notice is LICENSE.flare beside this file.
import { ROOT_CLUSTER, type RenderNode } from "./deriveGraph";

export type Rect = { id: string; x: number; y: number; w: number; h: number };

export type Item = { id: string; value: number };

/** Squarified treemap (Bruls et al.): tiles stay close to square. */
export function squarify(items: readonly Item[], rx: number, ry: number, rw: number, rh: number): Rect[] {
  const out: Rect[] = [];
  const remaining = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  let sum = remaining.reduce((a, i) => a + i.value, 0);
  if (sum <= 0) return out;
  let x = rx;
  let y = ry;
  let w = rw;
  let h = rh;

  while (remaining.length > 0 && w > 0.5 && h > 0.5) {
    const short = Math.min(w, h);
    const area = w * h;
    const row: Item[] = [];
    let rowSum = 0;
    let bestRatio = Infinity;

    while (remaining.length > 0) {
      const cand = remaining[0];
      const newSum = rowSum + cand.value;
      const rowLen = ((newSum / sum) * area) / short;
      let worst = 0;
      for (const it of [...row, cand]) {
        const side = (it.value / newSum) * short;
        if (side <= 0 || rowLen <= 0) continue;
        worst = Math.max(worst, Math.max(rowLen / side, side / rowLen));
      }
      if (worst <= bestRatio) {
        bestRatio = worst;
        row.push(cand);
        rowSum = newSum;
        remaining.shift();
      } else break;
    }

    const rowLen = ((rowSum / sum) * area) / short;
    let off = 0;
    for (const it of row) {
      const side = (it.value / rowSum) * short;
      if (w >= h) out.push({ id: it.id, x, y: y + off, w: rowLen, h: side });
      else out.push({ id: it.id, x: x + off, y, w: side, h: rowLen });
      off += side;
    }
    if (w >= h) {
      x += rowLen;
      w -= rowLen;
    } else {
      y += rowLen;
      h -= rowLen;
    }
    sum -= rowSum;
  }
  return out;
}

/** A file never vanishes: the smallest area a tile is packed at. */
export const MIN_CHARS = 200;
export const BLOCK_PAD = 3;
export const BLOCK_HEAD = 16;
export const PANE_PAD = 8;

export type DistrictBlock = Rect & { cluster: string; files: number; chars: number; heat: number };
export type DistrictTile = Rect & { node: RenderNode };
export type Districts = { blocks: DistrictBlock[]; tiles: DistrictTile[] };

/** Cluster blocks over the pane, file tiles inside each; `nodes` are file-level render nodes. */
export function districtsOf(nodes: readonly RenderNode[], width: number, height: number): Districts {
  const groups = new Map<string, RenderNode[]>();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const cluster = n.cluster || ROOT_CLUSTER;
    const list = groups.get(cluster);
    if (list) list.push(n);
    else groups.set(cluster, [n]);
  }
  const weight = (n: RenderNode) => Math.max(n.chars, MIN_CHARS);
  const blocksLaid = squarify(
    [...groups.entries()].map(([id, members]) => ({ id, value: members.reduce((a, n) => a + weight(n), 0) })),
    PANE_PAD,
    PANE_PAD,
    Math.max(40, width - PANE_PAD * 2),
    Math.max(40, height - PANE_PAD * 2),
  );
  const blocks: DistrictBlock[] = [];
  const tiles: DistrictTile[] = [];
  for (const rect of blocksLaid) {
    const members = groups.get(rect.id) ?? [];
    blocks.push({
      ...rect,
      cluster: rect.id,
      files: members.length,
      chars: members.reduce((a, n) => a + n.chars, 0),
      heat: members.reduce((m, n) => Math.max(m, n.heat), 0),
    });
    // A block too thin to hold a tile draws none: squarify stops under half a pixel.
    const inner = squarify(
      members.map(n => ({ id: n.id, value: weight(n) })),
      rect.x + BLOCK_PAD,
      rect.y + BLOCK_HEAD,
      Math.max(0, rect.w - BLOCK_PAD * 2),
      Math.max(0, rect.h - BLOCK_HEAD - BLOCK_PAD),
    );
    const byId = new Map(members.map(n => [n.id, n]));
    for (const t of inner) {
      const node = byId.get(t.id);
      if (node) tiles.push({ ...t, node });
    }
  }
  return { blocks, tiles };
}

/** The Hotspots ramp as a fill: tr-fail at an alpha that follows the heat, nothing at 0. */
export function heatFill(heat: number): string | undefined {
  if (heat <= 0) return undefined;
  return `color-mix(in srgb, var(--color-tr-fail) ${Math.round(8 + heat * 0.5)}%, transparent)`;
}

/** The tile with the most area, the drill's "largest rectangle". */
export function largestTile(districts: Districts): DistrictTile | null {
  let best: DistrictTile | null = null;
  for (const t of districts.tiles) if (!best || t.w * t.h > best.w * best.h) best = t;
  return best;
}
