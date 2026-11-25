// The chat column's frame: a drag handle on its left edge, and a thin rail when it is closed (#13987 drill).
import type { ReactNode, RefObject } from "react";
import { MessageCircle } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { CHAT_COLUMN, MIN_WIDTH, RAIL_WIDTH, type useChatColumn } from "./chatColumnState";
import { ResizeHandle } from "./ResizeHandle";

type Column = ReturnType<typeof useChatColumn>;

export function ChatColumn({ col, workspace, children }: { col: Column; workspace: RefObject<HTMLElement | null>; children: ReactNode }) {
  if (!col.open) {
    return (
      <aside aria-label="Chat rail" style={{ width: RAIL_WIDTH }}
        className="flex min-h-0 shrink-0 flex-col items-center border-l border-[var(--v2-edge)] bg-[var(--v2-side)] py-2">
        <IconButton label="Open chat" title="Open chat" size={30} onClick={() => col.setOpen(true)}><MessageCircle size={16} aria-hidden /></IconButton>
      </aside>
    );
  }
  return (
    <aside aria-label="Chat column" style={{ width: col.width, minWidth: MIN_WIDTH, maxWidth: "60%" }}
      className="relative flex min-h-0 shrink-0 border-l border-[var(--v2-edge)] bg-[var(--v2-side)]">
      <ResizeHandle cfg={CHAT_COLUMN} col={col} workspace={workspace} edge="left" label="Resize chat" />
      {children}
    </aside>
  );
}
