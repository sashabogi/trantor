// The five local dials plus the harness choice, read and written through the same Tauri commands
// classic Autonomy.tsx uses, so the dependency rules between dials stay in the CLI (#13994).
import { invoke } from "@tauri-apps/api/core";

export type Resolved = {
  harness: "prompt" | "bypass";
  commit: boolean;
  push: boolean;
  deploy: boolean;
  swapDeadSeat: boolean;
  retryFailedTurn: boolean;
};
export type DialKey = Exclude<keyof Resolved, "harness">;
export type AutonomyState = { project: string | null; resolved: Resolved; defaults: Resolved; overridden: string[]; path: string };

export type DialDef = { key: DialKey; label: string; why: string; needs?: DialKey };

/** Order and copy follow the artboard; the names are classic's. */
export const DIALS: readonly DialDef[] = [
  { key: "retryFailedTurn", label: "Retry a failed turn", why: "A turn that errored is re-run instead of leaving the seat idle." },
  { key: "swapDeadSeat", label: "Replace a dead seat", why: "Swaps a seat that ran out of quota; loses nothing." },
  { key: "commit", label: "Commit landed work", why: "Each seat's finished work is committed as that seat." },
  { key: "push", label: "Push after verifying", why: "Integrated work goes to the remote once tests pass.", needs: "commit" },
  { key: "deploy", label: "Deploy after pushing", why: "Runs the project's deploy step.", needs: "push" },
];

/** An outer dial can only be as open as the one it depends on: push needs commit, deploy needs push. */
export function dialBlockedBy(key: DialKey, r: Resolved): DialKey | null {
  const needs = DIALS.find(d => d.key === key)?.needs;
  return needs && !r[needs] ? needs : null;
}

export type AutonomyApi = {
  get: (project: string | null) => Promise<AutonomyState>;
  set: (project: string | null, dial: string, value: string) => Promise<AutonomyState>;
};

export const autonomyApi: AutonomyApi = {
  get: async project => JSON.parse(await invoke<string>("autonomy_get", { project })),
  set: async (project, dial, value) => JSON.parse(await invoke<string>("autonomy_set", { project, dial, value })),
};

/** The writes that bring `state` back to its defaults, closing outer dials before inner ones open. */
export function resetPlan(state: AutonomyState): Array<{ dial: string; value: string }> {
  const { resolved: r, defaults: d } = state;
  const changed = DIALS.filter(x => r[x.key] !== d[x.key]);
  const off = changed.filter(x => !d[x.key]).reverse();
  const on = changed.filter(x => d[x.key]);
  const plan: Array<{ dial: string; value: string }> = [...off, ...on].map(x => ({ dial: x.key, value: d[x.key] ? "on" : "off" }));
  if (r.harness !== d.harness) plan.push({ dial: "harness", value: d.harness });
  return plan;
}
