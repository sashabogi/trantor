// The model dial's value (#11657). Claude Code reads a project's model from its own
// .claude/settings.local.json over the user file, so a project's picker shows THAT project's
// effective model, never the user file's value alone. The Rust side (project_model.rs) resolves
// local over global; this picks between what the session said, what we sent, and that setting.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { Provenance } from "./Composer";

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

export type ConfiguredModel = { model: string; source: "local" | "global" } | null;

export const projectModelApi = {
  get: async (project: string, invokeFn: InvokeFn = invoke): Promise<ConfiguredModel> => {
    try {
      // SAFETY: project_model_get serialises {model, source} itself (settings.rs); anything else
      // parses to a value the checks below reject.
      const row = JSON.parse(await invokeFn<string>("project_model_get", { project })) as { model?: string | null; source?: string | null };
      if (!row.model || String(row.model) !== row.model) return null;
      return { model: row.model, source: row.source === "local" ? "local" : "global" };
    } catch { return null; }
  },
};

export type DialModel = { model: string; source: Provenance };

/** What the dial shows: a dispatch not yet confirmed first, then what the session reported, then
 *  the project's configured model — the one a fresh session will start on. */
export function dialModel(
  pending: string,
  reported: string,
  reportedSource: Provenance,
  configured: ConfiguredModel,
): DialModel {
  if (pending) return { model: pending, source: "dispatched" };
  if (reported) return { model: reported, source: reportedSource };
  if (configured) return { model: configured.model, source: "configured" };
  return { model: "", source: reportedSource };
}
