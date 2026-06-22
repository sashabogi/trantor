// Resolve provider API keys the SAME way the crew does (bin/crew-runner.mjs:130) so the balance checker
// can't miss a key that the agents themselves use. The crew sources, in order, ~/.token-scrooge/.env
// (Scrooge's integrated keys — deepseek/opencode-routed providers) then ~/.agent-bus/.env (Trantor's own
// key file — wins), on top of the inherited process.env. Reading bare process.env was the bug: keys like
// DEEPSEEK_API_KEY live in those .env files, not necessarily in the session/launchd environment.
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

// process.env overlaid by the key files (~/.agent-bus/.env wins). Use this everywhere a provider key is read.
export function resolveKeys(env = process.env, files = keyFiles()) {
  let merged = { ...env };
  for (const f of files) if (existsSync(f)) merged = { ...merged, ...parseEnvFile(f) };
  return merged;
}
