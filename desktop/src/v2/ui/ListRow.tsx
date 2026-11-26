// #14344: the one row every list in the sidebar shares: 24px, name first, meta truncating first, actions in
// a column that is only hidden until hover, so nothing reflows.
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Left padding in px: 8, plus 12 per depth level. */
export const rowIndent = (depth: number): number => 8 + depth * 12;

/** Hover, selected bar and focus ring, shared with the Explorer's own treeitem rows. */
export const LIST_ROW_SURFACE = [
  "group relative flex h-6 min-w-0 items-center gap-1.5 pr-2 text-v2-body text-[var(--v2-text)]",
  "hover:bg-[var(--v2-row-hover)] data-[selected=true]:bg-[var(--v2-accent-soft)]",
  "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-transparent data-[selected=true]:before:bg-[var(--v2-accent)]",
  "has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:-outline-offset-1 has-[:focus-visible]:outline-[var(--v2-accent)]",
  "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--v2-accent)]",
].join(" ");

export const ACTIONS_COLUMN = "invisible flex shrink-0 items-center gap-0.5 group-hover:visible group-focus-within:visible group-data-[selected=true]:visible";

export type RowMainProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "children"> & {
  "data-scope-row"?: string;
  "data-agent-row"?: string;
  "data-agent-file"?: string;
  "data-sha"?: string;
  "data-new"?: true;
};

export type RowShellProps = Omit<ComponentPropsWithoutRef<"div">, "className" | "children"> & {
  "data-change"?: string;
  "data-stash"?: string;
};

export type ListRowProps = {
  depth?: number;
  /** left padding in px, when the row aligns to something other than the depth scale */
  indent?: number;
  leading?: ReactNode;
  name: ReactNode;
  /** faint, truncates before the name does */
  meta?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  /** the far-right status letter */
  end?: ReactNode;
  selected?: boolean;
  className?: string;
  mainClassName?: string;
  /** makes the left cluster one button; its attributes land on that button */
  main?: RowMainProps;
  shell?: RowShellProps;
};

export function ListRow({ depth = 0, indent, leading, name, meta, trailing, actions, end, selected = false, className = "", mainClassName = "", main, shell }: ListRowProps) {
  const body = (
    <>
      {leading}
      <span className="min-w-0 shrink-[0.01] truncate">{name}</span>
      {meta ? <span className="min-w-0 shrink truncate text-v2-small text-[var(--v2-faint)]">{meta}</span> : null}
      <span className="flex-1" />
      {trailing}
    </>
  );
  const cluster = "flex h-full min-w-0 flex-1 items-center gap-1.5";
  return (
    <div {...shell} data-selected={selected || undefined} className={`${LIST_ROW_SURFACE} ${className}`}
      style={{ paddingLeft: indent ?? rowIndent(depth) }}>
      {main
        ? <button type="button" {...main} className={`${cluster} border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline-none ${mainClassName}`}>{body}</button>
        : <div className={cluster}>{body}</div>}
      {actions ? <span data-row-actions className={ACTIONS_COLUMN}>{actions}</span> : null}
      {end ? <span className="flex shrink-0 items-center">{end}</span> : null}
    </div>
  );
}
