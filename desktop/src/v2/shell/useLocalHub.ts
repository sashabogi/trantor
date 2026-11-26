// The app starts the local hub itself, once at mount (#14322). The state feeds the footer; Retry
// and the post-install retry call the same idempotent command.
import { useCallback, useEffect, useState } from "react";
import { localHubEnsure, type LocalHubState } from "../../shared/api/client";

export type LocalHub = { state: LocalHubState | null; starting: boolean; retry: () => void };

export function useLocalHub(ensure: () => Promise<LocalHubState> = localHubEnsure): LocalHub {
  const [state, setState] = useState<LocalHubState | null>(null);
  const [starting, setStarting] = useState(true);
  const run = useCallback(() => {
    setStarting(true);
    return ensure()
      .then(setState)
      // A mocked or older backend answers null: that is "no information", not a failure.
      .catch((e: Error) => setState({ state: "failed", detail: String(e), logPath: "~/.agent-bus/hub.log" }))
      .finally(() => setStarting(false));
  }, [ensure]);
  useEffect(() => { void run(); }, [run]);
  return { state, starting, retry: () => { void run(); } };
}
