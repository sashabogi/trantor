// The Settings nav model and its search, straight from the artboard's groups (#13994).
export type SectionId =
  | "general" | "notifications" | "accounts" | "models" | "phone" | "keyboard"
  | "agents" | "autonomy" | "agreements" | "memory" | "hooks" | "budgets"
  | "repository" | "worktrees" | "editor" | "extensions"
  | "hub" | "identity" | "storage" | "drill" | "about";

export type SectionDef = {
  id: SectionId;
  group: "You" | "Crew" | "Code and git" | "System";
  label: string;
  desc: string;
  /** Row-level words the search should also reach (what lives inside the page). */
  rows: readonly string[];
};

export const GROUPS = ["You", "Crew", "Code and git", "System"] as const;

export const SECTIONS: readonly SectionDef[] = [
  { id: "general", group: "You", label: "General", desc: "app to open code in, updates", rows: ["open code in", "editor", "updates", "check now", "trantor 2.0", "onboarding"] },
  { id: "notifications", group: "You", label: "Notifications", desc: "when, how, spoken alerts", rows: ["notify", "alerts", "spoken"] },
  { id: "accounts", group: "You", label: "Accounts and providers", desc: "logins, keys, plan status", rows: ["api key", "login", "keychain", "provider", "plan"] },
  { id: "models", group: "You", label: "Models", desc: "defaults per job", rows: ["default model", "per job"] },
  { id: "phone", group: "You", label: "Phone", desc: "pairing, what it may do", rows: ["pair", "qr", "iphone", "relay chat"] },
  { id: "keyboard", group: "You", label: "Keyboard", desc: "shortcuts and conflicts", rows: ["shortcuts", "conflicts"] },
  { id: "agents", group: "Crew", label: "Agents and harnesses", desc: "installed CLIs, launch commands", rows: ["installed", "default agent", "launch command", "codex", "claude"] },
  { id: "autonomy", group: "Crew", label: "Autonomy and permissions", desc: "what runs without asking", rows: ["commit", "push", "deploy", "replace a dead seat", "retry a failed turn", "overseer", "your session", "always allowed", "always asks", "force-push", "scope"] },
  { id: "agreements", group: "Crew", label: "Working agreements", desc: "what every seat is held to", rows: ["one card one branch", "drill", "red blocks merge", "blast radius", "commit"] },
  { id: "memory", group: "Crew", label: "Memory and rules", desc: "what loads into a turn", rows: [] },
  { id: "hooks", group: "Crew", label: "Hooks", desc: "what runs on events", rows: [] },
  { id: "budgets", group: "Crew", label: "Budgets and alerts", desc: "caps per metered provider", rows: [] },
  { id: "repository", group: "Code and git", label: "Repository", desc: "protected branches, merge method, gate", rows: ["protected branches", "merge method"] },
  { id: "worktrees", group: "Code and git", label: "Worktrees", desc: "where seats work", rows: [] },
  { id: "editor", group: "Code and git", label: "Editor", desc: "font, format on save", rows: ["font", "format on save"] },
  { id: "extensions", group: "Code and git", label: "Extensions and tools", desc: "opens its own screen", rows: ["mcp", "open vsx"] },
  { id: "hub", group: "System", label: "Hub and machines", desc: "netcup, tailnet, health", rows: ["hub", "pins", "reachable", "tailnet"] },
  { id: "identity", group: "System", label: "Identity and keys", desc: "signed requests, keychain", rows: ["signed", "key", "identity"] },
  { id: "storage", group: "System", label: "Storage", desc: "logs, transcripts, cleanup", rows: ["logs", "transcripts", "cleanup"] },
  { id: "drill", group: "System", label: "Drill mode", desc: "recorder settings", rows: ["recorder", "drill"] },
  { id: "about", group: "System", label: "About", desc: "version, update, licenses", rows: ["version", "licenses", "update"] },
];

/** True when every word of the query appears in the joined texts (an empty query matches). */
export function rowMatches(query: string, ...texts: string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = texts.join(" ").toLowerCase();
  return words.every(w => hay.includes(w));
}

/** Sections whose label, description, group or inner rows match the query. */
export function filterSections(query: string): SectionDef[] {
  return SECTIONS.filter(s => rowMatches(query, s.label, s.desc, s.group, s.rows.join(" ")));
}
