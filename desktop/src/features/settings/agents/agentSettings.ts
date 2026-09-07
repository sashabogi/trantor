import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { trantorCliCompatibility, type TrantorCliCompatibility } from "../../../shared/api/client";

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

type CompatibilityCommand = () => Promise<TrantorCliCompatibility>;
type AgentSettingsInvoke = <T>(command: string, args?: InvokeArgs) => Promise<T>;

export function createAgentSettingsApi(
  compatibility: CompatibilityCommand = trantorCliCompatibility,
  run: AgentSettingsInvoke = <T,>(command: string, args?: InvokeArgs) => invoke<T>(command, args),
): AgentSettingsApi {
  const action = async (command: string, args?: InvokeArgs): Promise<AgentSettingsStatus> => {
    const result = await compatibility();
    if (!result.compatible) {
      throw new Error(result.reason ?? `trantor CLI ${result.installed ?? "unknown"} is incompatible`);
    }
    return decode(await run<string>(command, args));
  };
  return {
    status: () => action("agent_settings_status"),
    setEnabled: (id, enabled) => action("agent_settings_set_enabled", { id, enabled }),
    setDefault: id => action("agent_settings_set_default", { id }),
  };
}

export const agentSettingsApi = createAgentSettingsApi();
