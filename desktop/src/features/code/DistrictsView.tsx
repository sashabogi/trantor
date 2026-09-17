// The districts layout on the Code surface (#7978, blueprint §4.1): the second layout behind
// the graph's tr-seg. Cluster blocks over the pane, file tiles inside by size; the lenses
// recolour the same tiles the flow layout draws as cards. Layout maths: graph/districts.ts.
import { hueOf } from "../../shared/Avatar";
import { BLOCK_HEAD, heatFill, type Districts } from "./graph/districts";
import type { GraphLens, RenderNode } from "./graph/deriveGraph";

const clusterTint = (cluster: string, alpha: number) => `hsl(${hueOf(cluster)} 28% 58% / ${alpha})`;

export function DistrictsView({ districts, lens, selected, width, height, onCard }: {
  districts: Districts;
  lens: GraphLens;
  selected: string | null;
  width: number;
  height: number;
  onCard: (node: RenderNode) => void;
}) {
  return (
    <div className="relative" style={{ width, height }} data-testid="districts-view">
      {districts.blocks.map(b => (
        <div
          key={b.cluster}
          className="absolute overflow-hidden rounded-[6px] border border-tr-edge"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, background: clusterTint(b.cluster, 0.08) }}
          data-district={b.cluster}
          title={`${b.cluster} · ${b.files} files · ${b.chars.toLocaleString()} chars`}
        >
          {b.w > 36 && (
            <div
              className="tr-mono truncate px-1.5 text-[10px] font-semibold leading-[16px] text-tr-muted"
              style={{ height: BLOCK_HEAD }}
            >
              {b.cluster}
            </div>
          )}
        </div>
      ))}
      {districts.tiles.map(({ node, x, y, w, h }) => {
        const isSelected = node.id === selected;
        const fill = lens === "hotspots" ? heatFill(node.heat) : clusterTint(node.cluster, 0.22);
        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onCard(node)}
            data-graph-node={node.id}
            data-graph-kind="file"
            data-graph-cluster={node.cluster}
            data-graph-tone={node.tone}
            data-graph-heat={node.heat}
            data-graph-area={Math.round(w * h)}
            title={`${node.id} · ${node.chars.toLocaleString()} chars · heat ${node.heat}`}
            className="absolute overflow-hidden rounded-[4px] text-left text-[10.5px] text-tr-text"
            style={{
              left: x,
              top: y,
              width: Math.max(1, w - 1),
              height: Math.max(1, h - 1),
              background: fill,
              boxShadow: isSelected ? "inset 0 0 0 1.5px var(--color-tr-doing)" : "inset 0 0 0 1px var(--color-tr-edge)",
              opacity: node.tone === "dim" ? 0.4 : 1,
            }}
          >
            {w > 44 && h > 14 && <span className="block truncate px-1 leading-[14px]">{node.label}</span>}
            {node.seats.map(s => (
              <span
                key={s ?? "checkout"}
                className="tr-dot absolute right-1 top-1"
                style={{ background: s ? `hsl(${hueOf(s)} 55% 62%)` : "var(--color-tr-muted)", width: 5, height: 5 }}
                data-graph-seat={s ?? "checkout"}
              />
            ))}
          </button>
        );
      })}
    </div>
  );
}
