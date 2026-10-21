// Codex's MCP env table overrides ambient runner variables and may pin another seat.
export function codexRelayFlags({ persona, session, project, hub }) {
  const env = { RELAY_AGENT: persona, RELAY_SESSION: session, RELAY_PROJECT: project, RELAY_URL: hub };
  return Object.entries(env).map(([key, value]) => {
    const setting = `mcp_servers.relay.env.${key}=${JSON.stringify(value)}`;
    return ` -c '${setting.replaceAll("'", "'\"'\"'")}'`;
  }).join("");
}
