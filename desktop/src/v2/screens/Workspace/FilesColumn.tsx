// The source control sidebar on the left of the Workspace (#14044): Changes, Files and Recent
// commits fed by useScopeGit, collapsible to a rail, resizable (#13987 drill). #14047: a Branches
// and seats row click selects that seat in the strip, and the main checkout row selects the orchestrator.
import type { RefObject } from "react";
import { ChevronsLeft, Files } from "lucide-react";
import type { SeatInfo } from "../Code/model";
import { useScopeGit } from "../Code/useScopeGit";
import { IconButton } from "../../ui/IconButton";
import { ScmSidebar } from "../../ui/ScmSidebar";
import { Splitter } from "../../ui/Splitter";
import { FILES_COLUMN, FILES_MIN_WIDTH, FILES_RAIL_WIDTH, maxFor, workspaceWidth, type useFilesColumn } from "./chatColumnState";

type Column = ReturnType<typeof useFilesColumn>;

export type FilesColumnProps = {
  col: Column; workspace: RefObject<HTMLElement | null>; project: string;
  /** the seat whose worktree to show, or null for the project checkout. */
  scope: string | null; scopeName: string;
  /** the project's seats, as screens/Code/useSeats reads them */
  seats: SeatInfo[];
  /** a Branches and seats row click: null is the main checkout, which selects the orchestrator */
  onPickScope: (seat: string | null) => void;
  onOpenFile: (path: string) => void;
  onOpenChange: (path: string) => void;
  onOpenCommit: (sha: string) => void;
};

/** The open column: the shared sidebar with this scope's git state, collapse button included. */
function ScmColumn(p: FilesColumnProps) {
  const { state, refresh } = useScopeGit(p.project, p.scope);
  return (
    <ScmSidebar project={p.project} scope={p.scope} scopeName={p.scopeName} state={state} seats={p.seats} onPickScope={p.onPickScope}
      onMutated={refresh} onOpenFile={p.onOpenFile} onOpenChange={p.onOpenChange} onOpenCommit={p.onOpenCommit}
      actions={<IconButton label="Collapse files" title="Collapse the source control sidebar to a rail" size={26} onClick={() => p.col.setOpen(false)}>
        <ChevronsLeft size={14} aria-hidden />
      </IconButton>} />
  );
}

export function FilesColumn(p: FilesColumnProps) {
  if (!p.col.open) {
    return (
      <aside aria-label="Files rail" style={{ width: FILES_RAIL_WIDTH }}
        className="flex min-h-0 shrink-0 flex-col items-center border-r border-[var(--v2-edge)] bg-[var(--v2-side)] py-2">
        <IconButton label="Open files" title="Open the source control sidebar" size={30} onClick={() => p.col.setOpen(true)}><Files size={16} aria-hidden /></IconButton>
      </aside>
    );
  }
  return (
    <aside aria-label="Source control" style={{ width: p.col.width, minWidth: FILES_MIN_WIDTH, maxWidth: "40%" }}
      className="relative flex min-h-0 shrink-0 flex-col border-r border-[var(--v2-edge)] bg-[var(--v2-side)]">
      <Splitter orientation="columns" edge="right" label="Resize files" title="Drag to resize, double-click to reset"
        value={p.col.width} min={FILES_COLUMN.min} max={maxFor(FILES_COLUMN, workspaceWidth(p.workspace))}
        onChange={p.col.setWidth} onCommit={p.col.commitWidth} onReset={() => p.col.commitWidth(FILES_COLUMN.fallbackWidth)} />
      <ScmColumn {...p} />
    </aside>
  );
}
