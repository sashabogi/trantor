import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

let ownMachineCache: string | undefined;
let pending: Promise<string | undefined> | undefined;

/** This machine's label (~/.agent-bus/machine-id via the machine_id command), cached per run. */
export function useOwnMachineId(): string | undefined {
  const [own, setOwn] = useState<string | undefined>(ownMachineCache);
  useEffect(() => {
    if (ownMachineCache !== undefined) { setOwn(ownMachineCache); return; }
    let alive = true;
    pending ??= invoke<string>("machine_id").then(id => {
      ownMachineCache = id?.trim() || undefined;
      return ownMachineCache;
    }).catch(() => { pending = undefined; return undefined; });
    pending.then(id => { if (alive) setOwn(id); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return own;
}
