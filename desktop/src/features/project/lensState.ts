// The project lens the app reopens on (#11597), durable per project via the same convention
// rightPanelState.ts uses for the right panel (#6499). The remembered value covers every lens
// tab, the Graph lens included; the compat values never come back as tabs.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { LENSES, type Lens } from "./ProjectHeader";

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** The stored lens if it names a current tab — "graph" included — else null. The compat values
 *  ("files"/"review") were never tabs and must never come back as one. */
export function lensOf(stored: string | null): Lens | null {
  return LENSES.find(lens => lens === stored) ?? null;
}

export const projectLensApi = {
  get: async (project: string, invokeFn: InvokeFn = invoke): Promise<Lens | null> => {
    try {
      // SAFETY: project_lens_get's Rust side only ever stores a string this module itself wrote
      // through `set` below (project_lens.rs's map), or JSON null for an untouched project —
      // the same trust boundary rightPanelState.ts documents for its own command.
      const parsed = JSON.parse(await invokeFn<string>("project_lens_get", { project })) as string | null;
      return lensOf(parsed);
    } catch { return null; }
  },
  set: async (project: string, lens: Lens, invokeFn: InvokeFn = invoke): Promise<void> => {
    try { await invokeFn("project_lens_set", { project, lens }); }
    catch { /* a refusing store keeps this session's choice in memory only */ }
  },
};

/** What a project reopens on: whatever was saved for it last, or the Code-lens-era default
 *  Board when nothing was ever saved. */
export function initialLens(stored: Lens | null): Lens {
  return stored ?? "board";
}
