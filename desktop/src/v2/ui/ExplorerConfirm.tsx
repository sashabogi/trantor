// The Explorer's own delete question. The webview's confirm() shows nothing in the built app, so
// a delete that waited on it never ran (#14106 drill).
import { Button } from "./Button";

export function DeleteConfirm({ text, onConfirm, onCancel }: { text: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label="Delete" data-explorer-confirm
      className="mx-2 mb-1 flex flex-col gap-2 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-2.5 py-2 text-[11.5px] text-[var(--v2-text-2)]">
      <span>{text}</span>
      <div className="flex gap-2">
        <Button variant="danger" onClick={onConfirm}>Delete</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
