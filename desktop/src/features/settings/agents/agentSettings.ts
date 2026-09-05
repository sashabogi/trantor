import { invoke } from "@tauri-apps/api/core";

export type AgentStatus = {
  id: string;
  label: string;
  launch: string;
  cli: string;
  installed: boolean;
  enabled: boolean;
  isDefault: boolean;
  homepage: string;
  install: string;
};

export type AgentSettingsStatus = {
  default: string | null;
  agents: AgentStatus[];
};

export type AgentSettingsApi = {
  status: () => Promise<AgentSettingsStatus>;
  setEnabled: (id: string, enabled: boolean) => Promise<AgentSettingsStatus>;
  setDefault: (id: string | null) => Promise<AgentSettingsStatus>;
};

// SAFETY: every agent-settings CLI branch serializes buildAgentSettingsStatus, and Tauri returns
// that stdout unchanged; component tests exercise the complete status shape at this boundary.
const decode = (raw: string): AgentSettingsStatus => JSON.parse(raw) as AgentSettingsStatus;

export const agentSettingsApi: AgentSettingsApi = {
  status: async () => decode(await invoke<string>("agent_settings_status")),
  setEnabled: async (id, enabled) => decode(await invoke<string>("agent_settings_set_enabled", { id, enabled })),
  setDefault: async id => decode(await invoke<string>("agent_settings_set_default", { id })),
};
