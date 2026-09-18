// Resolve provider API keys the SAME way the crew does (~/.token-scrooge/.env, then ~/.agent-bus/.env
// which wins, over process.env) so the balance checker never misses a key the agents themselves use.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Minimal .env parser: KEY=value / export KEY=value, strips matching quotes, ignores blanks/comments.
export function parseEnvFile(file) {
  const out = {};
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

// The key files Trantor/the crew read, low → high precedence (later wins), matching crew-runner.
export function keyFiles() {
  return [join(homedir(), ".token-scrooge", ".env"), join(homedir(), ".agent-bus", ".env")];
}

// Layers, low to high: process.env, the key files (~/.agent-bus/.env wins), then the secret store
// when the caller hands it over (#6393: pass resolveSecrets(); a drill that never opens the store
// never reads a keychain). Use this everywhere a provider key is read.
export function resolveKeys(env = process.env, files = keyFiles(), secrets = null) {
  let merged = { ...env };
  for (const f of files) if (existsSync(f)) merged = { ...merged, ...parseEnvFile(f) };
  return secrets ? { ...merged, ...secrets } : merged;
}
