// The card sheet (#14327): the existing card detail in a sheet over the 2.0 shell, mounted once, so a
// card link in a transcript opens the card wherever the operator is. The detail itself is imported,
// never forked.
import { useEffect, useSyncExternalStore } from "react";
import type { HubClient } from "../../shared/api/client";
import { CardDetail } from "../../features/board/CardDetail";
import { closeCardSheet, currentCardSheet, openCardSheet, watchCardSheet } from "./cardIntent";

export function CardSheet({ client }: { client: HubClient }) {
  const open = useSyncExternalStore(watchCardSheet, currentCardSheet);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeCardSheet(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div role="dialog" aria-label={`Card #${open.id}`} data-testid="card-sheet" className="fixed inset-0 z-50">
      <CardDetail client={client} id={open.id} onClose={closeCardSheet} onOpen={id => openCardSheet(open.project, id)} />
    </div>
  );
}
