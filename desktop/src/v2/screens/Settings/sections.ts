// The Settings nav model and its search, straight from the artboard's groups (#13994).
export type SectionId =
  | "general" | "notifications" | "keyboard" | "accounts" | "phone"
  | "agents" | "autonomy" | "agreements"
  | "extensions" | "hub" | "identity" | "about";

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
  { id: "general", group: "You", label: "General", desc: "app to open code in, updates", rows: ["projects folder root directory checkout development TRANTOR_DEV_ROOT", "open code in", "editor", "updates", "check now", "trantor 2.0", "onboarding"] },
  { id: "notifications", group: "You", label: "Notifications", desc: "when Trantor interrupts you", rows: ["notify", "alerts", "background"] },
  { id: "keyboard", group: "You", label: "Keyboard", desc: "every shortcut, grouped", rows: ["shortcuts", "keys", "chord", "command palette", "go to file", "quick open"] },
  { id: "accounts", group: "You", label: "Accounts and providers", desc: "logins, keys, plan status", rows: ["api key", "login", "keychain", "provider", "plan"] },
  { id: "phone", group: "You", label: "Phone", desc: "pairing, what it may do", rows: ["pair", "qr", "iphone", "relay chat"] },
  { id: "agents", group: "Crew", label: "Agents and harnesses", desc: "installed CLIs, launch commands", rows: ["installed", "default agent", "launch command", "codex", "claude"] },
  { id: "autonomy", group: "Crew", label: "Autonomy and permissions", desc: "what runs without asking", rows: ["commit", "push", "deploy", "replace a dead seat", "retry a failed turn", "overseer", "your session", "always asks", "force-push", "scope"] },
  { id: "agreements", group: "Crew", label: "Working agreements", desc: "what every seat is held to", rows: ["one card one branch", "drill", "red blocks merge", "blast radius", "commit"] },
  { id: "extensions", group: "Code and git", label: "Extensions and tools", desc: "opens its own screen", rows: ["mcp", "open vsx"] },
  { id: "hub", group: "System", label: "Hub and machines", desc: "Connections, machines and health", rows: ["hub", "pins", "reachable", "tailnet"] },
  { id: "identity", group: "System", label: "Identity and keys", desc: "signed requests, keychain", rows: ["signed", "key", "identity"] },
  { id: "about", group: "System", label: "About", desc: "version, update, licenses", rows: ["version", "licenses", "update", "agent clis", "claude code"] },
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

/** The rows of one page that the search keeps; a search that only matched the page keeps every row (#14268). */
export function keptRows(query: string, section: string, words: Readonly<Record<string, string>>): ReadonlySet<string> {
  const keys = Object.keys(words);
  const hits = keys.filter(k => rowMatches(query, section, words[k] ?? ""));
  return new Set(hits.length ? hits : keys);
}
