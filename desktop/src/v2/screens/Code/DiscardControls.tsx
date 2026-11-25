import { useState } from "react";
import { Button } from "../../ui/Button";
import { scopeDiscard } from "./scopeGitApi";

export type DiscardTarget = { path: string | null };

export function useDiscard(project: string, scope: string | null, onMutated: () => void) {
  const [target, setTarget] = useState<DiscardTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    if (!target) return;
    setBusy(true);
    scopeDiscard(project, scope, target.path ? [target.path] : undefined)
      .then(() => { setTarget(null); setError(null); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { target, setTarget, busy, error, confirm };
}

export function DiscardConfirmation({ target, busy, onConfirm, onCancel }: {
  target: DiscardTarget; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const name = target.path ?? "all changes";
  return (
    <div role="alert" data-discard-confirm={target.path ?? "all"} className="flex flex-col gap-2 border-y border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-3 py-2 text-v2-body text-[var(--v2-text-2)]">
      <span>Discard {name}? Tracked edits are restored and untracked files are removed. Every existing file is copied to a dated Trash folder first.</span>
      <div className="flex gap-2">
        <Button variant="danger" disabledReason={busy ? "Copying to Trash and discarding" : null} onClick={onConfirm}>Discard {name}</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
