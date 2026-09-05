import type { ProviderStatus } from "./providerStatus";

export type ProviderPresentation = {
  mode: "system" | "key" | "readonly";
  description: string;
  homepage: string;
  source?: string;
  steps?: string[];
};

const KEY_STEPS = [
  "Open the provider console and sign in.",
  "Create an API key for this machine.",
  "Copy the complete key and paste it here.",
];

const PRESENTATIONS: Record<string, ProviderPresentation> = {
  claude: {
    mode: "system",
    description: "Optional. Trantor can use your normal Claude login; add an account only when you need to sign in or switch the system login.",
    homepage: "https://docs.anthropic.com/en/docs/claude-code",
  },
  codex: {
    mode: "system",
    description: "Optional. Trantor can use your normal Codex login; add an account only when you need to sign in or switch the system login.",
    homepage: "https://developers.openai.com/codex/cli/",
  },
  zai: {
    mode: "key",
    description: "Configure the API key used by GLM crew seats and live usage checks.",
    homepage: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    source: "Z.ai console",
    steps: KEY_STEPS,
  },
  glm: {
    mode: "key",
    description: "Configure the API key used by GLM crew seats and live usage checks.",
    homepage: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    source: "Z.ai console",
    steps: KEY_STEPS,
  },
  kimi: {
    mode: "key",
    description: "Configure the API key used by Kimi Code and its quota checks.",
    homepage: "https://platform.moonshot.cn/console/api-keys",
    source: "Moonshot platform",
    steps: KEY_STEPS,
  },
  qwen: {
    mode: "key",
    description: "Configure the API key used by Qwen Code and its quota checks.",
    homepage: "https://bailian.console.aliyun.com/",
    source: "Alibaba Cloud Model Studio",
    steps: KEY_STEPS,
  },
  deepseek: {
    mode: "key",
    description: "Configure the API key used by DeepSeek seats and prepaid balance checks.",
    homepage: "https://platform.deepseek.com/api_keys",
    source: "DeepSeek platform",
    steps: KEY_STEPS,
  },
  openrouter: {
    mode: "key",
    description: "Configure the OpenRouter key that fronts the models available to your crew.",
    homepage: "https://openrouter.ai/settings/keys",
    source: "OpenRouter settings",
    steps: KEY_STEPS,
  },
  moonshot: {
    mode: "key",
    description: "Configure a Moonshot platform key, separate from the Kimi Code login.",
    homepage: "https://platform.moonshot.cn/console/api-keys",
    source: "Moonshot platform",
    steps: KEY_STEPS,
  },
  agy: {
    mode: "readonly",
    description: "Shows sign-in readiness detected from the Antigravity CLI on this machine.",
    homepage: "https://antigravity.google/",
  },
};

export function providerPresentation(status: ProviderStatus): ProviderPresentation {
  const known = PRESENTATIONS[status.provider];
  if (known) return known;
  return {
    mode: status.connect === "api-key" ? "key" : "readonly",
    description: `Shows the ${status.label} account and live connection state used by Trantor.`,
    homepage: "",
    source: `${status.label} account console`,
    steps: KEY_STEPS,
  };
}
