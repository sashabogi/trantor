// The drag handle shared by the chat column (left edge) and the files column (right edge) (#13987 drill).
import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { clampFor, KEY_STEP, maxFor, type ColumnConfig, type useColumn } from "./chatColumnState";

type Column = ReturnType<typeof useColumn>;

// #13987 drill: the workspace is the flex parent; happy-dom and first paint report 0, so fall back to the window.
const workspaceWidth = (ref: RefObject<HTMLElement | null>) => ref.current?.getBoundingClientRect().width || window.innerWidth;

export function ResizeHandle({ cfg, col, workspace, edge, label }: {
  cfg: ColumnConfig; col: Column; workspace: RefObject<HTMLElement | null>; edge: "left" | "right"; label: string;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  // A handle on the left edge widens its column when dragged left; on the right edge, when dragged right.
  const sign = edge === "left" ? -1 : 1;
  const max = maxFor(cfg, workspaceWidth(workspace));
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: col.width };
    const widthAt = (x: number) => clampFor(cfg, (drag.current?.w ?? col.width) + sign * (x - (drag.current?.x ?? x)), workspaceWidth(workspace));
    const move = (ev: PointerEvent) => { if (drag.current) col.setWidth(widthAt(ev.clientX)); };
    const end = (ev: PointerEvent) => {
      if (drag.current) col.commitWidth(widthAt(ev.clientX));
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    e.preventDefault();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const widen = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const narrow = edge === "left" ? "ArrowRight" : "ArrowLeft";
    const dir = e.key === widen ? 1 : e.key === narrow ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    col.commitWidth(clampFor(cfg, col.width + dir * KEY_STEP, workspaceWidth(workspace)));
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} title="Drag to resize, double-click to reset"
      tabIndex={0} aria-valuenow={col.width} aria-valuemin={cfg.min} aria-valuemax={max}
      onPointerDown={start} onKeyDown={key} onDoubleClick={() => col.commitWidth(cfg.fallbackWidth)}
      style={{ touchAction: "none" }}
      className={`absolute inset-y-0 z-30 w-[6px] cursor-col-resize hover:bg-[var(--v2-accent-soft)] focus-visible:bg-[var(--v2-accent-soft)] ${edge === "left" ? "-left-[3px]" : "-right-[3px]"}`} />
  );
}
