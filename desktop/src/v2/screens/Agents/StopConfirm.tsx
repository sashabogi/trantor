// An inline "Stop this seat?" asked in place; never window.confirm, which shows nothing in the built app (#14268).
import { Button } from "../../ui/Button";
import { useEscape } from "../../ui/useEscape";

export type StopConfirmProps = { name: string; detail: string; busy: boolean; onStop: () => void; onCancel: () => void };

export function StopConfirm({ name, detail, busy, onStop, onCancel }: StopConfirmProps) {
  useEscape(onCancel);
  return (
    <div role="alertdialog" aria-label={`Stop ${name}?`} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--v2-bad-edge)] bg-[var(--v2-bad-soft)] px-2.5 py-2 text-v2-body">
      <span className="min-w-0 flex-1 text-[var(--v2-text)]">Stop {name}? {detail}.</span>
      <Button variant="danger" disabledReason={busy ? "Another action is running" : null} onClick={onStop}>Stop {name}</Button>
      <Button onClick={onCancel}>Keep running</Button>
    </div>
  );
}
