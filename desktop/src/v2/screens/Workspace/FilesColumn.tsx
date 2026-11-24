// The Explorer on the left of the Workspace: the classic FileTree, collapsible to a rail, resizable (#13987 drill).
import type { RefObject } from "react";
import { ChevronsLeft, Files } from "lucide-react";
import { FileTree } from "../../../features/code/FileTree";
import { IconButton } from "../../ui/IconButton";
import { FILES_COLUMN, FILES_MIN_WIDTH, FILES_RAIL_WIDTH, type useFilesColumn } from "./chatColumnState";
import { ResizeHandle } from "./ResizeHandle";

type Column = ReturnType<typeof useFilesColumn>;

export function FilesColumn({ col, workspace, project, scope, scopeName, onOpenFile }: {
  col: Column; workspace: RefObject<HTMLElement | null>; project: string;
  /** The seat whose worktree to show, or null for the project checkout. */
  scope: string | null; scopeName: string; onOpenFile: (path: string) => void;
}) {
  if (!col.open) {
    return (
      <aside aria-label="Files rail" style={{ width: FILES_RAIL_WIDTH }}
        className="flex min-h-0 shrink-0 flex-col items-center border-r border-[var(--v2-edge)] bg-[#0F1013] py-2">
        <IconButton label="Open files" title="Open the file explorer" size={30} onClick={() => col.setOpen(true)}><Files size={16} aria-hidden /></IconButton>
      </aside>
    );
  }
  return (
    <aside aria-label="Files column" style={{ width: col.width, minWidth: FILES_MIN_WIDTH, maxWidth: "40%" }}
      className="relative flex min-h-0 shrink-0 flex-col border-r border-[var(--v2-edge)] bg-[#0F1013]">
      <ResizeHandle cfg={FILES_COLUMN} col={col} workspace={workspace} edge="right" label="Resize files" />
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--v2-edge)] px-2.5 py-1.5">
        <span className="text-[12.5px] font-semibold">Files</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--v2-muted)]" title={scopeName}>{scopeName}</span>
        <IconButton label="Collapse files" title="Collapse the file explorer to a rail" size={26} onClick={() => col.setOpen(false)}>
          <ChevronsLeft size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto"><FileTree project={project} seat={scope} onOpen={onOpenFile} /></div>
    </aside>
  );
}
