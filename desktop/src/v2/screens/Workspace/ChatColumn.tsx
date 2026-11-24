// The chat column's frame: a drag handle on its left edge, and a thin rail when it is closed (#13987 drill).
import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { MessageCircle } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { clampWidth, DEFAULT_WIDTH, KEY_STEP, MIN_WIDTH, maxWidthFor, RAIL_WIDTH, type useChatColumn } from "./chatColumnState";

type Column = ReturnType<typeof useChatColumn>;

// #13987 drill: the workspace is the flex parent; happy-dom and first paint report 0, so fall back to the window.
const workspaceWidth = (ref: RefObject<HTMLElement | null>) => ref.current?.getBoundingClientRect().width || window.innerWidth;

function Handle({ col, workspace }: { col: Column; workspace: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const max = maxWidthFor(workspaceWidth(workspace));
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: col.width };
    const widthAt = (x: number) => clampWidth((drag.current?.w ?? col.width) + ((drag.current?.x ?? x) - x), workspaceWidth(workspace));
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
    // The handle sits on the left edge, so Left widens the column and Right narrows it.
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    col.commitWidth(clampWidth(col.width + dir * KEY_STEP, workspaceWidth(workspace)));
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize chat" title="Drag to resize, double-click to reset"
      tabIndex={0} aria-valuenow={col.width} aria-valuemin={MIN_WIDTH} aria-valuemax={max}
      onPointerDown={start} onKeyDown={key} onDoubleClick={() => col.commitWidth(DEFAULT_WIDTH)}
      style={{ touchAction: "none" }}
      className="absolute inset-y-0 -left-[3px] z-30 w-[6px] cursor-col-resize hover:bg-[var(--v2-accent-soft)] focus-visible:bg-[var(--v2-accent-soft)]" />
  );
}

export function ChatColumn({ col, workspace, children }: { col: Column; workspace: RefObject<HTMLElement | null>; children: ReactNode }) {
  if (!col.open) {
    return (
      <aside aria-label="Chat rail" style={{ width: RAIL_WIDTH }}
        className="flex min-h-0 shrink-0 flex-col items-center border-l border-[var(--v2-edge)] bg-[#0F1013] py-2">
        <IconButton label="Open chat" title="Open chat" size={30} onClick={() => col.setOpen(true)}><MessageCircle size={16} aria-hidden /></IconButton>
      </aside>
    );
  }
  return (
    <aside aria-label="Chat column" style={{ width: col.width, minWidth: MIN_WIDTH, maxWidth: "60%" }}
      className="relative flex min-h-0 shrink-0 border-l border-[var(--v2-edge)] bg-[#0F1013]">
      <Handle col={col} workspace={workspace} />
      {children}
    </aside>
  );
}
