// One resize handle for columns and rows: a 3-dot grip always visible, an accent line on
// hover, focus and drag (#14241). Replaces the two bare 6px strips.
import { useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const KEY_STEP = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/** Columns resize a width by dragging sideways; rows resize a height by dragging vertically. */
export type SplitterProps = {
  orientation: "columns" | "rows";
  /** The edge of its pane the strip sits on; it sets the drag sign and the arrow keys. */
  edge: "left" | "right" | "top";
  /** Accessible name, e.g. "Resize chat". */
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  /** The live value while a drag runs. */
  onChange: (value: number) => void;
  /** The final value on pointer up or an arrow key. */
  onCommit: (value: number) => void;
  /** Double-click resets to the fallback; only the workspace columns have one. */
  onReset?: () => void;
};

export function Splitter(p: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const atOf = (point: { clientX: number; clientY: number }) => (p.orientation === "rows" ? point.clientY : point.clientX);
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = p.value;
    const at = atOf(e);
    // A strip on the left or top edge grows its pane when dragged against that edge.
    const sign = p.edge === "right" ? 1 : -1;
    const valueAt = (point: { clientX: number; clientY: number }) => clamp(from + sign * (atOf(point) - at), p.min, p.max);
    const move = (ev: PointerEvent) => p.onChange(valueAt(ev));
    const end = (ev: PointerEvent) => {
      p.onCommit(valueAt(ev));
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    setDragging(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    e.preventDefault();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = p.edge === "top" ? "ArrowUp" : p.edge === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = p.edge === "top" ? "ArrowDown" : p.edge === "left" ? "ArrowRight" : "ArrowLeft";
    const dir = e.key === grow ? 1 : e.key === shrink ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    p.onCommit(clamp(p.value + dir * KEY_STEP, p.min, p.max));
  };
  const columns = p.orientation === "columns";
  return (
    <div role="separator" aria-orientation={columns ? "vertical" : "horizontal"} aria-label={p.label} title={p.title}
      tabIndex={0} aria-valuenow={p.value} aria-valuemin={p.min} aria-valuemax={p.max}
      onPointerDown={start} onKeyDown={key} onDoubleClick={p.onReset} style={{ touchAction: "none" }}
      className={`group absolute z-30 flex select-none ${columns
        ? `inset-y-0 w-[6px] cursor-col-resize ${p.edge === "left" ? "-left-[3px]" : "-right-[3px]"}`
        : "inset-x-0 -top-[3px] h-[6px] cursor-row-resize"} ${dragging ? "bg-[var(--v2-accent-soft)]" : ""}`}>
      <span aria-hidden data-grip className={`m-auto flex gap-[2px] ${columns ? "flex-col" : "flex-row"}`}>
        <span className="h-[3px] w-[3px] rounded-full bg-[var(--v2-muted)] group-hover:bg-[var(--v2-accent)]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[var(--v2-muted)] group-hover:bg-[var(--v2-accent)]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[var(--v2-muted)] group-hover:bg-[var(--v2-accent)]" />
      </span>
      <span aria-hidden data-line className={`absolute rounded-full bg-[var(--v2-accent)] ${columns
        ? "bottom-[2px] left-[2px] top-[2px] w-[2px]"
        : "left-[2px] right-[2px] top-[2px] h-[2px]"} ${dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`} />
    </div>
  );
}
