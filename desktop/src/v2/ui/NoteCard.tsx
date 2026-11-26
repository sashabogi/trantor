// #14344: a needs-you note: a warn-tinted card with one line of text and one action link.
import type { ReactNode } from "react";

export type NoteCardProps = {
  children: ReactNode;
  action?: { label: string; onClick: () => void; title?: string };
  /** a test hook naming what the note is about */
  note?: string;
};

export function NoteCard({ children, action, note }: NoteCardProps) {
  return (
    <div role="note" data-note={note} className="flex items-center gap-2 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-2.5 py-2 text-v2-small text-[var(--v2-text)]">
      <span className="min-w-0 flex-1">{children}</span>
      {action && (
        <button type="button" title={action.title} onClick={action.onClick}
          className="shrink-0 border-0 bg-transparent p-0 text-v2-small text-[var(--v2-link)]">{action.label}</button>
      )}
    </div>
  );
}
