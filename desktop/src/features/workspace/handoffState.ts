import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type HandoffState = { project: string; id: string; state: "WRITTEN" | "CLAIMED" | "RECAPPED" };
let records: HandoffState[] = [];
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let pending = false;

async function refresh(epoch: number) {
  if (pending) return;
  pending = true;
  try {
    const next = await invoke<HandoffState[]>("handoff_states");
    if (epoch !== generation) return;
    records = next;
    for (const subscriber of subscribers) subscriber();
  } catch { /* Keep the last observed state through transient IPC failures. */ }
  finally { pending = false; }
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    const epoch = ++generation;
    void refresh(epoch);
    timer = setInterval(() => void refresh(epoch), 2000);
  }
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) { clearInterval(timer); generation++; }
  };
}

export function useHandoffState(project: string) {
  return useSyncExternalStore(subscribe, () => records.find(record => record.project === project));
}

export function handoffWaiting(state?: HandoffState) {
  return state?.state === "WRITTEN" || state?.state === "CLAIMED";
}
