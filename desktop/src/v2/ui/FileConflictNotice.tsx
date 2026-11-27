import { useState } from "react";
import { Button } from "./Button";
import { NoteCard } from "./NoteCard";
import { Section } from "./Section";

export function FileConflictNotice({ mine, theirs, truncated, onKeepMine, onLoadTheirs }: {
  mine: string; theirs: string; truncated: boolean; onKeepMine: () => void; onLoadTheirs: () => void;
}) {
  const [compare, setCompare] = useState(false);
  return (
    <div className="shrink-0 border-b border-[var(--v2-edge)] p-2">
      <NoteCard note="file-changed-on-disk">
        <span role="status">This file changed on disk. Your edits are still here.{truncated && " The disk preview is truncated; saving is off."}</span>
        <span className="ml-2 inline-flex flex-wrap gap-1">
          <Button variant="quiet" onClick={onKeepMine} title="Keep your edits and use the shown disk copy as the next save’s baseline">Keep mine</Button>
          <Button variant="quiet" onClick={onLoadTheirs}>Load theirs</Button>
          <Button variant="quiet" aria-expanded={compare} onClick={() => setCompare(value => !value)}>{compare ? "Hide comparison" : "Compare"}</Button>
        </span>
      </NoteCard>
      {compare && (
        <div className="mt-2 grid max-h-80 grid-cols-2 gap-2 overflow-auto" aria-label="Compare file versions">
          <Section title="On disk" flush><pre tabIndex={0} className="v2-mono m-0 overflow-auto p-3 text-v2-body text-[var(--v2-text)]">{theirs}</pre></Section>
          <Section title="Your edits" flush><pre tabIndex={0} className="v2-mono m-0 overflow-auto p-3 text-v2-body text-[var(--v2-text)]">{mine}</pre></Section>
        </div>
      )}
    </div>
  );
}
