import { EFFORT_LABELS, type Effort, type Permission } from "./Composer2";

export type HarnessName = "claude" | "codex" | "glm" | "kimi" | "deepseek" | "qwen" | "gemini" | "unknown";

type EffortControl = {
  levels: readonly Effort[];
  command: (effort: Effort) => string;
};

type PermissionControl =
  | { kind: "autonomy" }
  | { kind: "command"; commands: Record<Permission, string> };

export type HarnessCapabilities = {
  effort?: EffortControl;
  permission?: PermissionControl;
};

const effortCommand = (prefix: string) => (effort: Effort) => `${prefix}${EFFORT_LABELS[effort]}`;
const NONE: HarnessCapabilities = {};

// Only in-session controls confirmed in the launchers, model catalog, or the harness itself appear here.
export const HARNESS_CAPABILITIES = {
  claude: {
    effort: { levels: [0, 1, 2, 3], command: effortCommand("/effort ") },
    permission: { kind: "autonomy" },
  },
  codex: {
    effort: { levels: [0, 1, 2, 3], command: effortCommand("/model --reasoning ") },
    permission: { kind: "command", commands: {
      ask: "/permissions :read-only",
      guarded: "/permissions :workspace",
      auto: "/permissions :danger-full-access",
    } },
  },
  glm: NONE,
  kimi: NONE,
  deepseek: NONE,
  qwen: NONE,
  gemini: NONE,
  unknown: NONE,
} satisfies Record<HarnessName, HarnessCapabilities>;

function harnessName(agent: string): HarnessName {
  const name = agent.trim().toLowerCase().split(":")[0].replace(/-\d+$/, "");
  if (/^(claude|anthropic|sonnet)$/.test(name)) return "claude";
  if (/^(codex|openai)$/.test(name)) return "codex";
  if (/^(glm|zai|zhipu)$/.test(name)) return "glm";
  if (/^(kimi|moonshot)$/.test(name)) return "kimi";
  if (name === "deepseek") return "deepseek";
  if (name === "qwen") return "qwen";
  if (/^(gemini|google)$/.test(name)) return "gemini";
  return "unknown";
}

export function harnessCapabilities(agent: string): HarnessCapabilities {
  return HARNESS_CAPABILITIES[harnessName(agent)];
}
