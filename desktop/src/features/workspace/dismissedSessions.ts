import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { DismissedSession } from "./restorables";

async function invokeList(cmd: string, args?: InvokeArgs): Promise<DismissedSession[]> {
  return JSON.parse(await invoke<string>(cmd, args));
}

export const dismissedSessionsApi = {
  list: (): Promise<DismissedSession[]> => invokeList("dismissed_sessions_list"),
  dismiss: (project: string, sessionId: string): Promise<DismissedSession[]> =>
    invokeList("dismissed_sessions_dismiss", { project, sessionId }),
  /** A real Wake on `project` — clears every dismissal recorded against it. */
  clear: (project: string): Promise<DismissedSession[]> =>
    invokeList("dismissed_sessions_clear", { project }),
};
