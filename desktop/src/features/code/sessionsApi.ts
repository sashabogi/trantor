import { invoke } from "@tauri-apps/api/core";

export type SessionScope = "worktree" | "project" | "all";
export type SessionHarness = "claude" | "codex" | "opencode" | "kimi";

export type SessionRow = {
  id: string;
  harness: SessionHarness;
  title: string;
  lastMessage: string;
  messageCount: number;
  model: string;
  branch: string;
  updatedAt: number;
  cwd: string;
};

export type TranscriptMessage = { role: "user" | "assistant"; text: string };

export const harnessLabel = (harness: SessionHarness): string => ({
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  kimi: "Kimi",
})[harness];

export function sessionAge(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function sessionMatches(row: SessionRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.title, row.lastMessage, row.harness, row.model, row.branch, row.cwd]
    .some(value => value.toLowerCase().includes(needle));
}

/** A harness store that could not be read: its sessions are missing, everyone else's are listed. */
export type StoreWarning = { store: string; message: string };
export type SessionsListing = { sessions: SessionRow[]; warnings: StoreWarning[] };

/** #13987 drill: the listing carries per-store warnings; a bare array is the older shape. */
export function parseSessionsListing(raw: string): SessionsListing {
  const parsed: SessionRow[] | Partial<SessionsListing> = JSON.parse(raw);
  if (Array.isArray(parsed)) return { sessions: parsed, warnings: [] };
  return { sessions: parsed.sessions ?? [], warnings: parsed.warnings ?? [] };
}

export function storeLabel(store: string): string {
  return store === "claude" || store === "codex" || store === "opencode" || store === "kimi" ? harnessLabel(store) : store;
}

export async function sessionsList(project: string, scope: SessionScope): Promise<SessionsListing> {
  return parseSessionsListing(await invoke<string>("sessions_list", { project, scope }));
}

export async function sessionTranscript(
  project: string,
  row: SessionRow,
): Promise<TranscriptMessage[]> {
  return JSON.parse(await invoke<string>("session_transcript", {
    project,
    harness: row.harness,
    id: row.id,
  }));
}
