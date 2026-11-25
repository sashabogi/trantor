// Top-edge resize handle for the bottom panel, shared by pointer and keyboard resizing (#14071).
import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampHeight, KEY_STEP, maxHeight, MIN_HEIGHT } from "./state";

export function ResizeHandle({ height, columnHeight, onChange, onCommit }: {
  height: number; columnHeight: () => number; onChange: (height: number) => void; onCommit: (height: number) => void;
}) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { y: event.clientY, height };
    const heightAt = (y: number) => clampHeight((drag.current?.height ?? height) + (drag.current?.y ?? y) - y, columnHeight());
    const move = (ev: PointerEvent) => { if (drag.current) onChange(heightAt(ev.clientY)); };
    const end = (ev: PointerEvent) => {
      if (drag.current) onCommit(heightAt(ev.clientY));
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    event.preventDefault();
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    onCommit(clampHeight(height + direction * KEY_STEP, columnHeight()));
  };
  return (
    <div role="separator" aria-orientation="horizontal" aria-label="Resize bottom panel" title="Drag to resize, or use the up and down arrow keys"
      tabIndex={0} aria-valuenow={height} aria-valuemin={MIN_HEIGHT} aria-valuemax={maxHeight(columnHeight())}
      onPointerDown={start} onKeyDown={key} style={{ touchAction: "none" }}
      className="absolute inset-x-0 -top-[3px] z-30 h-[6px] cursor-row-resize hover:bg-[var(--v2-accent-soft)] focus-visible:bg-[var(--v2-accent-soft)]" />
  );
}
