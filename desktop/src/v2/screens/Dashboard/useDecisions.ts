// The Dashboard's write actions: approve/deny a proposal, go/no-go a hold; the row leaves at once (#13986).
import { useState } from "react";
import type { FileHold, HubClient, Proposal } from "../../../shared/api/client";

export function useDecisions(client: HubClient) {
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = async (key: string, act: () => Promise<{ ok: boolean }>) => {
    setBusy(key); setError("");
    try {
      await act();
      setDecided(d => new Set(d).add(key));
    } catch (e) {
      setError(`Decision could not be saved: ${e instanceof Error && e.message ? e.message : "try again"}`);
    } finally { setBusy(""); }
  };

  return {
    decided, busy, error,
    decideProposal: (p: Proposal, status: "approved" | "denied") => run(`proposal:${p.id}`, () => client.decideProposal(p.id, status)),
    decideHold: (h: FileHold, status: "go" | "nogo") => run(`hold:${h.id}`, () => client.decideHold(h, status)),
  };
}

export type Decisions = ReturnType<typeof useDecisions>;
