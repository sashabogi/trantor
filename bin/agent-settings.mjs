#!/usr/bin/env node
import { buildAgentSettingsStatus, setAgentEnabled, setDefaultAgent } from "../lib/agent-preferences.mjs";

const [command = "status", id, value] = process.argv.slice(2).filter(argument => argument !== "--json");

try {
  const result = command === "status"
    ? buildAgentSettingsStatus()
    : command === "set-enabled"
      ? setAgentEnabled(id, value === "true")
      : command === "set-default"
        ? setDefaultAgent(id === "auto" ? null : id)
        : null;
  if (!result) {
    console.error("usage: agent-settings.mjs status | set-enabled <agent> <true|false> | set-default <agent|auto>");
    process.exit(1);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
