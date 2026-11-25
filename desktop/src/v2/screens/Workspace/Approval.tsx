// A seat's pending file-edit decision, answerable in place; the same hub holds the Inbox lists (#13987).
import { useState } from "react";
import { Lock } from "lucide-react";
import type { FileHold, HubClient } from "../../../shared/api/client";
import { Button } from "../../ui/Button";

export function Approval({ client, holds, seatName, onDecided }: {
  client: HubClient; holds: FileHold[]; seatName: string; onDecided: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  if (!holds.length) return null;
  const decide = async (hold: FileHold, status: "go" | "nogo") => {
    setBusy(hold.id);
    setError("");
    try { await client.decideHold(hold, status); onDecided(); }
    catch { setError("The decision could not be saved. Try again."); }
    finally { setBusy(null); }
  };
  return (
    <div className="mx-3 mb-3 flex flex-col gap-2">
      {holds.map(h => (
        <div key={h.id} role="group" aria-label={`${seatName} needs a decision on ${h.file}`}
          className="flex flex-wrap items-center gap-2.5 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-panel)] px-3 py-[11px]">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--v2-warn-soft)] text-[var(--v2-warn)]">
            <Lock size={14} aria-hidden />
          </span>
          <div className="min-w-0 flex-[1_1_260px]">
            <div className="font-medium">Allow {seatName} to edit <span className="v2-mono break-all">{h.file}</span>?</div>
            <div className="text-v2-body text-[var(--v2-muted)]">{h.other}'s claim holds it. Go lets the edit through; No-go keeps it held until that claim ends.</div>
          </div>
          <Button disabledReason={busy !== null ? "Saving a decision" : null} onClick={() => void decide(h, "go")}
            className="!border-0 !bg-[var(--v2-warn)] !text-[var(--v2-warn-ink)] font-semibold">Go</Button>
          <Button variant="quiet" disabledReason={busy !== null ? "Saving a decision" : null} onClick={() => void decide(h, "nogo")}>No-go</Button>
        </div>
      ))}
      {error && <div role="alert" className="text-v2-body text-[var(--v2-bad)]">{error}</div>}
    </div>
  );
}
