// Regression for the key-resolution bug: the balance checker read bare process.env and missed keys that
// live in the .env files the crew sources (~/.token-scrooge/.env, ~/.agent-bus/.env) — e.g. DEEPSEEK_API_KEY.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, resolveKeys } from "./lib/provider-keys.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

const dir = mkdtempSync(join(tmpdir(), "trantor-keys-"));
const scrooge = join(dir, "token-scrooge.env");
const agentbus = join(dir, "agent-bus.env");
writeFileSync(scrooge, [
  "# scrooge keys",
  "DEEPSEEK_API_KEY=sk-deepseek-fromscrooge",
  'GEMINI_API_KEY="sk-gemini-quoted"',
  "export ZAI_API_KEY=sk-zai-exported",
  "SHARED_KEY=from-scrooge",
  "",
].join("\n"));
writeFileSync(agentbus, ["SHARED_KEY=from-agentbus", "KIMI_API_KEY=sk-kimi"].join("\n"));

// --- parseEnvFile ---
const p = parseEnvFile(scrooge);
ok(p.DEEPSEEK_API_KEY === "sk-deepseek-fromscrooge", "parseEnvFile: plain KEY=value");
ok(p.GEMINI_API_KEY === "sk-gemini-quoted", "parseEnvFile: strips double quotes");
ok(p.ZAI_API_KEY === "sk-zai-exported", "parseEnvFile: handles `export ` prefix");
ok(!("# scrooge keys" in p), "parseEnvFile: ignores comments/blanks");

// --- resolveKeys precedence: process.env < scrooge < agent-bus (agent-bus wins) ---
const merged = resolveKeys({ EXISTING: "env", SHARED_KEY: "from-env" }, [scrooge, agentbus]);
ok(merged.EXISTING === "env", "resolveKeys: keeps ambient env vars");
ok(merged.DEEPSEEK_API_KEY === "sk-deepseek-fromscrooge", "resolveKeys: finds DEEPSEEK from scrooge env (the bug)");
ok(merged.KIMI_API_KEY === "sk-kimi", "resolveKeys: finds key from agent-bus env");
ok(merged.SHARED_KEY === "from-agentbus", "resolveKeys: agent-bus wins over scrooge wins over process.env");
ok(resolveKeys({ A: "1" }, ["/nope/missing.env"]).A === "1", "resolveKeys: missing files are skipped (fail-soft)");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
