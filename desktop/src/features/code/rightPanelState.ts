// The right mode pane's tab + dock state, persisted per project in ~/.agent-bus/config.json (#6499:
// the panel always reopened on Files, so a waiting ask sat unseen). The config.json convention is
// for durable per-PROJECT state; the localStorage seam is per-mode/global.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

export type PanelTab = "files" | "git" | "sessions" | "chat";

/** Chat's own Dock type also has "right"/"bottom", but ModePane only ever hosts "pane" (#5841
 *  moved Chat's dock chrome here) — kept as a field so a stored value is not silently dropped if
 *  a real dock choice ever comes back. */
export type PanelDock = "pane";

export type RightPanelState = { tab: PanelTab; dock: PanelDock };

const TABS: readonly PanelTab[] = ["files", "git", "sessions", "chat"];

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** `invokeFn` is injectable the way herdr's `answerAtPane` is — a test supplies a faithful
 *  in-memory stand-in instead of mocking the Tauri module, so the actual persist/restore round
 *  trip is provable without touching real IPC. */
export const rightPanelApi = {
  get: async (project: string, invokeFn: InvokeFn = invoke): Promise<RightPanelState | null> => {
    try {
      // SAFETY: right_panel_get's Rust side only ever stores a shape this module itself wrote
      // through `set` below (right_panel.rs's RightPanelState), or null for an untouched
      // project — the same trust boundary herdr.ts's herdrSeats() documents for Rust's own JSON.
      const parsed = JSON.parse(await invokeFn<string>("right_panel_get", { project })) as RightPanelState | null;
      if (!parsed || !TABS.includes(parsed.tab)) return null;
      return { tab: parsed.tab, dock: "pane" };
    } catch { return null; }
  },
  set: async (project: string, tab: PanelTab, invokeFn: InvokeFn = invoke): Promise<void> => {
    try { await invokeFn("right_panel_set", { project, tab, dock: "pane" satisfies PanelDock }); }
    catch { /* a refusing store keeps this session's choice in memory only */ }
  },
};

/** #6499 item 1 — the tab a project's panel opens on: whatever was saved for it last, or Chat
 *  when nothing was ever saved and the project's orchestrator is live (a question may already be
 *  waiting there), or Files otherwise — today's plain default for a project nobody has touched. */
export function initialTab(stored: PanelTab | null, orchestratorLive: boolean): PanelTab {
  if (stored) return stored;
  return orchestratorLive ? "chat" : "files";
}

/** #6499 item 2 — mirrors app/projectActivity.ts's `needsYou`: only "blocked" reads as the
 *  session sitting on an approval or an AskUserQuestion, waiting on the operator specifically.
 *  Kept as its own one-liner rather than importing app/ code into a feature — features never
 *  reach up into app/. */
export function chatTabNeedsYou(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "blocked";
}
