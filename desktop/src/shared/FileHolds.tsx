import { useEffect, useState } from "react";
import type { FileHold, HubClient } from "./api/client";

export function usePendingHolds(client: HubClient | null): FileHold[] {
  const [holds, setHolds] = useState<FileHold[]>([]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    const load = () => client.holds().then(r => { if (active) setHolds(r.holds); })
      .catch(() => { /* Keep the last known decisions visible during connection loss. */ });
    load();
    const timer = setInterval(load, 60_000);
    const off = client.streamEvents(ev => { if (ev.type.startsWith("hold.")) load(); });
    return () => { active = false; clearInterval(timer); off(); };
  }, [client]);
  return holds;
}

export function FileHoldsSection({ client }: { client: HubClient }) {
  const holds = usePendingHolds(client);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const decide = async (hold: FileHold, status: "go" | "nogo") => {
    setBusy(hold.id);
    setError("");
    try { await client.decideHold(hold, status); }
    catch { setError("Decision could not be saved. Try again."); }
    finally { setBusy(null); }
  };
  if (!holds.length) return null;
  return (
    <section className="min-w-0 mb-6">
      <h2 className="tr-sec-title">File edits need your decision</h2>
      <p className="tr-sec-sub">Go permits the edit. No-go keeps it held until the earlier claim ends.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-col gap-2">
        {holds.map(hold => (
          <div key={hold.id} className="tr-card p-3.5">
            <div className="text-[13px] break-words">{hold.file}</div>
            <p className="text-[12px] text-[var(--color-tr-muted)]">{hold.session} is held by {hold.other}’s claim in {hold.project}.</p>
            <div className="mt-2 flex gap-2">
              <button disabled={busy !== null} onClick={() => decide(hold, "go")} className="tr-chip px-2.5 py-1 disabled:opacity-40">Go</button>
              <button disabled={busy !== null} onClick={() => decide(hold, "nogo")} className="tr-chip px-2.5 py-1 disabled:opacity-40">No-go</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
