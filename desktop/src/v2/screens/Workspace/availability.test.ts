import { expect, it } from "vitest";
import { unavailableAgentReason } from "./useCrew";
import type { AgentStatus } from "../../../features/settings/agents/agentSettings";
const agent: AgentStatus = { id: "codex", label: "Codex", launch: "codex", cli: "codex", installed: true, enabled: true, isDefault: false, homepage: "", install: "" };
it("distinguishes missing, disabled and quota-limited agents", () => {
  expect(unavailableAgentReason({ agents: [{ ...agent, installed: false }], balances: [] })).toContain("No agent CLI is installed");
  expect(unavailableAgentReason({ agents: [{ ...agent, enabled: false }], balances: [] })).toContain("Installed agents are disabled");
  expect(unavailableAgentReason({ agents: [agent], balances: [{ provider: "codex", ok: true, remainingPct: 0 }] })).toContain("no usable quota");
});
it("excludes the current agent when explaining an empty swap menu", () => {
  expect(unavailableAgentReason({ agents: [agent], balances: [] }, "codex")).toBe("No other agents are configured");
  expect(unavailableAgentReason(null)).toBe("Reading installed agents");
});
